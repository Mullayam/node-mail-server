// Command imapctl talks to a running IMAP server through its control socket.
//
//	imapctl reload                 re-read imap.xml and the users, update Gluon
//	imapctl status
//	imapctl routes                 list every command the server knows
//	imapctl user list
//	imapctl user get <address>
//	imapctl user add <address> -password P [-imap=true] [-quota-storage 1GB] [-quota-messages N]
//	imapctl user update <address> [-password P] [-imap=false] [...]
//	imapctl user delete <address>
//	imapctl quota get <address>
//	imapctl quota set <address> [-storage 2GB] [-messages N]
//	imapctl mail deliver <address> [-mailbox NAME] < message.eml
//
// In Docker: docker compose -f deploy/docker-compose.yml exec imap imapctl reload
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"imap/internal/control"
)

func main() {
	socket := flag.String("socket", env("IMAP_CONTROL_SOCKET", control.DefaultSocket()), "control socket of the running server")
	flag.Usage = usage
	flag.Parse()

	req, err := build(flag.Args())
	if err != nil {
		fmt.Fprintf(os.Stderr, "imapctl: %v\n\n", err)
		usage()
		os.Exit(2)
	}

	resp, err := control.Do(*socket, req, 60*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "imapctl: %v\n", err)
		os.Exit(1)
	}
	if !resp.OK {
		fmt.Fprintf(os.Stderr, "imapctl %s: %s\n", req.Command, resp.Error)
		os.Exit(1)
	}
	var pretty any
	if len(resp.Data) > 0 && json.Unmarshal(resp.Data, &pretty) == nil {
		out, _ := json.MarshalIndent(pretty, "", "  ")
		fmt.Println(string(out))
	} else {
		fmt.Println("ok")
	}
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func usage() {
	fmt.Fprint(os.Stderr, `usage: imapctl [-socket PATH] <command>

  reload | reloadxml       re-read imap.xml and the users, then update Gluon
  status                   show what the server has loaded
  routes                   list every command the server knows

  user list
  user get <address>
  user add <address> -password P [-imap=true] [-quota-storage 1GB] [-quota-messages N]
  user update <address> [-password P] [-imap=true|false] [-quota-storage S] [-quota-messages N]
  user delete <address>

  quota get <address>
  quota set <address> [-storage 2GB] [-messages N]

  mail deliver <address> [-mailbox NAME] [-file message.eml]
                           store a message (from stdin; INBOX, or Junk when it is
                           marked as spam) and show it to connected clients at once

Use -password-stdin instead of -password to keep the password out of the process list.

Docker: docker compose -f deploy/docker-compose.yml exec imap imapctl reload
`)
}

// build turns the command line into a router command and its arguments.
func build(args []string) (control.Request, error) {
	if len(args) == 0 {
		return control.Request{}, errors.New("no command")
	}
	switch args[0] {
	case "reload", "reloadxml", "status", "routes":
		return control.Request{Command: args[0]}, nil
	case "user", "quota", "mail":
		if len(args) < 2 {
			return control.Request{}, fmt.Errorf("%s needs a subcommand", args[0])
		}
	default:
		return control.Request{Command: args[0]}, nil // let the server answer unknown commands
	}

	group, sub := args[0], args[1]
	command := group + "." + sub
	if group == "user" && sub == "list" {
		return control.Request{Command: command}, nil
	}
	if len(args) < 3 || strings.HasPrefix(args[2], "-") {
		return control.Request{}, fmt.Errorf("%s %s needs an address", group, sub)
	}
	reqArgs := map[string]string{"address": args[2]}

	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	var names []string
	switch command {
	case "user.add", "user.update":
		names = []string{"password", "imap", "quota-storage", "quota-messages"}
	case "quota.set":
		names = []string{"storage", "messages"}
	case "mail.deliver":
		names = []string{"mailbox"}
	}
	values := map[string]*string{}
	for _, n := range names {
		values[n] = fs.String(n, "", "")
	}
	passwordStdin := fs.Bool("password-stdin", false, "read the password from stdin")
	file := fs.String("file", "", "mail deliver: read the message from this file instead of stdin")
	if err := fs.Parse(args[3:]); err != nil {
		return control.Request{}, err
	}
	if command == "mail.deliver" {
		var src io.Reader = os.Stdin
		if *file != "" {
			f, err := os.Open(*file)
			if err != nil {
				return control.Request{}, err
			}
			defer f.Close()
			src = f
		}
		msg, err := io.ReadAll(io.LimitReader(src, control.MaxRequestBytes))
		if err != nil {
			return control.Request{}, fmt.Errorf("read message: %w", err)
		}
		if len(msg) == 0 {
			return control.Request{}, errors.New("mail deliver: no message on stdin (or use -file)")
		}
		reqArgs["message"] = string(msg)
	}
	fs.Visit(func(f *flag.Flag) {
		if v, ok := values[f.Name]; ok {
			reqArgs[f.Name] = *v
		}
	})
	if *passwordStdin {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return control.Request{}, fmt.Errorf("read password from stdin: %w", err)
		}
		reqArgs["password"] = strings.TrimRight(line, "\r\n")
	}
	return control.Request{Command: command, Args: reqArgs}, nil
}
