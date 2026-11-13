package conf

import (
	"encoding/xml"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"imap/internal/filing"
	"imap/internal/quota"
)

const (
	DefaultListen    = "0.0.0.0:143"
	DefaultTLSListen = "0.0.0.0:993"
	DefaultDataDir   = "/data"
)

type TLS struct {
	Cert   string `json:"cert,omitempty"`
	Key    string `json:"key,omitempty"`
	Listen string `json:"listen,omitempty"`
}

func (t TLS) Enabled() bool { return t.Cert != "" }

var DefaultLMTPTrusted = []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

type LMTP struct {
	Listen  string         `json:"listen,omitempty"`
	Trusted []netip.Prefix `json:"trusted,omitempty"`
}

func (l LMTP) Enabled() bool { return l.Listen != "" }

func (l LMTP) Allows(addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, p := range l.Trusted {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

type Plugin struct {
	Name    string
	Options map[string]string
}

func pluginXML(d *xml.Decoder, start xml.StartElement, key string) (Plugin, error) {
	p := Plugin{Options: map[string]string{}}
	for _, a := range start.Attr {
		if a.Name.Local == key {
			p.Name = strings.TrimSpace(a.Value)
		} else {
			p.Options[a.Name.Local] = a.Value
		}
	}
	return p, d.Skip()
}

type directoryElem struct{ Plugin }

func (e *directoryElem) UnmarshalXML(d *xml.Decoder, start xml.StartElement) (err error) {
	e.Plugin, err = pluginXML(d, start, "kind")
	return err
}

type storageElem struct{ Plugin }

func (e *storageElem) UnmarshalXML(d *xml.Decoder, start xml.StartElement) (err error) {
	e.Plugin, err = pluginXML(d, start, "engine")
	return err
}

type file struct {
	XMLName  xml.Name `xml:"imap"`
	Settings struct {
		Listen struct {
			Address string `xml:"address,attr"`
		} `xml:"listen"`
		Data struct {
			Dir string `xml:"dir,attr"`
		} `xml:"data"`
		TLS struct {
			Cert   string `xml:"cert,attr"`
			Key    string `xml:"key,attr"`
			Listen string `xml:"listen,attr"`
		} `xml:"tls"`
		LMTP struct {
			Listen  string `xml:"listen,attr"`
			Trusted string `xml:"trusted,attr"`
		} `xml:"lmtp"`
	} `xml:"settings"`
	Directory directoryElem `xml:"directory"`
	Storage   storageElem   `xml:"storage"`
	Quota     struct {
		Storage  string `xml:"storage,attr"`
		Messages string `xml:"messages,attr"`
	} `xml:"quota"`
	Delivery *struct {
		SpamMailbox *string `xml:"spam-mailbox,attr"`
		SpamHeaders string  `xml:"spam-headers,attr"`
	} `xml:"delivery"`
}

var (
	DefaultSpamMailbox = "Junk"
	DefaultSpamHeaders = []string{"X-AE-Spam-Flag", "X-Spam-Flag"}
)

type Conf struct {
	Listen    string
	TLS       TLS
	LMTP      LMTP
	DataDir   string
	Directory Plugin
	Storage   Plugin
	Quota     quota.Limit
	Delivery  filing.Rules
	Warnings  []string
}

func Load(path string) (*Conf, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(data)
}

func Parse(data []byte) (*Conf, error) {
	var f file
	if err := xml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("imap.xml: %w", err)
	}
	c := &Conf{
		Listen:    orDefault(f.Settings.Listen.Address, DefaultListen),
		DataDir:   orDefault(f.Settings.Data.Dir, DefaultDataDir),
		Directory: f.Directory.Plugin,
		Storage:   f.Storage.Plugin,
	}

	var problems []error
	if err := checkListen(c.Listen); err != nil {
		problems = append(problems, err)
	}
	t := f.Settings.TLS
	c.TLS = TLS{Cert: strings.TrimSpace(t.Cert), Key: strings.TrimSpace(t.Key)}
	switch {
	case (c.TLS.Cert == "") != (c.TLS.Key == ""):
		problems = append(problems, errors.New("<tls> needs both cert and key"))
	case c.TLS.Enabled():
		c.TLS.Listen = orDefault(t.Listen, DefaultTLSListen)
		if err := checkListen(c.TLS.Listen); err != nil {
			problems = append(problems, fmt.Errorf("<tls listen>: %w", err))
		}
	}
	if l := f.Settings.LMTP; strings.TrimSpace(l.Listen) != "" {
		c.LMTP.Listen = strings.TrimSpace(l.Listen)
		if err := checkListen(c.LMTP.Listen); err != nil {
			problems = append(problems, fmt.Errorf("<lmtp listen>: %w", err))
		}
		cidrs := DefaultLMTPTrusted
		if strings.TrimSpace(l.Trusted) != "" {
			cidrs = strings.Split(l.Trusted, ",")
		}
		for _, s := range cidrs {
			p, err := netip.ParsePrefix(strings.TrimSpace(s))
			if err != nil {
				problems = append(problems, fmt.Errorf("<lmtp trusted>: %q is not a CIDR range", strings.TrimSpace(s)))
				continue
			}
			c.LMTP.Trusted = append(c.LMTP.Trusted, p.Masked())
		}
	}
	if c.Directory.Name == "" {
		problems = append(problems, errors.New(`<directory kind="..."> is missing`))
	}
	if c.Storage.Name == "" {
		problems = append(problems, errors.New(`<storage engine="..."> is missing`))
	}
	c.Delivery = filing.Rules{SpamMailbox: DefaultSpamMailbox, SpamHeaders: DefaultSpamHeaders}
	if d := f.Delivery; d != nil {
		if d.SpamMailbox != nil {
			c.Delivery.SpamMailbox = strings.TrimSpace(*d.SpamMailbox)
		}
		if strings.TrimSpace(d.SpamHeaders) != "" {
			c.Delivery.SpamHeaders = nil
			for _, h := range strings.Split(d.SpamHeaders, ",") {
				if h = strings.TrimSpace(h); h != "" {
					c.Delivery.SpamHeaders = append(c.Delivery.SpamHeaders, h)
				}
			}
		}
	}

	var err error
	if c.Quota.StorageBytes, err = quota.ParseSize(f.Quota.Storage); err != nil {
		problems = append(problems, fmt.Errorf("<quota storage>: %w", err))
	}
	if c.Quota.Messages, err = quota.ParseCount(f.Quota.Messages); err != nil {
		problems = append(problems, fmt.Errorf("<quota messages>: %w", err))
	}
	if len(problems) > 0 {
		return nil, errors.Join(problems...)
	}
	if c.Quota == (quota.Limit{}) {
		c.Warnings = append(c.Warnings, "no default quota: mailboxes are unlimited")
	}
	return c, nil
}

func orDefault(v, def string) string {
	if v = strings.TrimSpace(v); v == "" {
		return def
	}
	return v
}

func checkListen(addr string) error {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("listen address %q: %w", addr, err)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 0 || n > 65535 {
		return fmt.Errorf("listen address %q: invalid port", addr)
	}
	return nil
}

type Snapshot struct {
	*Conf
	Generation uint64
	LoadedAt   time.Time
	Path       string
}

type Holder struct {
	path string
	mu   sync.Mutex
	cur  atomic.Pointer[Snapshot]
}

func NewHolder(path string) (*Holder, error) {
	c, err := Load(path)
	if err != nil {
		return nil, err
	}
	h := &Holder{path: path}
	h.cur.Store(&Snapshot{Conf: c, Generation: 1, LoadedAt: time.Now(), Path: path})
	return h, nil
}

func (h *Holder) Current() *Snapshot { return h.cur.Load() }

type ReloadReport struct {
	Generation      uint64   `json:"generation"`
	QuotaChanged    bool     `json:"quota_changed"`
	RestartRequired []string `json:"restart_required,omitempty"`
	Warnings        []string `json:"warnings,omitempty"`
}

func (h *Holder) Reload() (*ReloadReport, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	old := h.cur.Load()
	next, err := Load(h.path)
	if err != nil {
		return nil, fmt.Errorf("imap.xml is invalid, keeping generation %d: %w", old.Generation, err)
	}
	snap := &Snapshot{Conf: next, Generation: old.Generation + 1, LoadedAt: time.Now(), Path: h.path}
	h.cur.Store(snap)

	r := &ReloadReport{Generation: snap.Generation, QuotaChanged: old.Quota != next.Quota, Warnings: next.Warnings}
	restart := func(what, from, to string) {
		if from != to {
			r.RestartRequired = append(r.RestartRequired, fmt.Sprintf("%s %q -> %q", what, from, to))
		}
	}
	restart("listen", old.Listen, next.Listen)
	restart("tls listen", old.TLS.Listen, next.TLS.Listen)
	restart("lmtp listen", old.LMTP.Listen, next.LMTP.Listen)
	restart("data dir", old.DataDir, next.DataDir)
	restart("directory kind", old.Directory.Name, next.Directory.Name)
	restart("storage engine", old.Storage.Name, next.Storage.Name)
	if !maps.Equal(old.Directory.Options, next.Directory.Options) {
		r.RestartRequired = append(r.RestartRequired, "directory options changed")
	}
	if !maps.Equal(old.Storage.Options, next.Storage.Options) {
		r.RestartRequired = append(r.RestartRequired, "storage options changed")
	}
	sort.Strings(r.RestartRequired)
	return r, nil
}
