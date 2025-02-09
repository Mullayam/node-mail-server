package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/smtp"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rovergulf/mta"
)

var ctx = context.Background()

func main() {
	rdb := redis.NewClient(&redis.Options{
		Addr: "localhost:6379",
	})
	NewRedis(rdb)
	for {
		job, err := rdb.BLPop(ctx, 0*time.Second, "bull:email-job-queue:waiting").Result()
		if err != nil {
			log.Println("Error fetching job:", err)
			continue
		}

		if len(job) < 2 {
			continue
		}

		var emailData Email
		err = json.Unmarshal([]byte(job[1]), &emailData)
		if err != nil {
			log.Println("Error parsing email job data:", err)
			continue
		}
		fmt.Println("📧 Processing Email:")

		SendMail(emailData)

	}
}

type RedisClient struct {
	rdb *redis.Client
}

func (rdb *RedisClient) PublishLogs(logType string, event string, from string, message string) error {

	logMessage := fmt.Sprintf("Email failed to send to %s: %s", from, message)

	logs := struct {
		LogType    string `json:"type"`
		Event      string `json:"event"`
		Message    string `json:"message"`
		Timestamp  string `json:"timestamp"`
		DomainName string `json:"domain_name"`
	}{
		LogType:    logType,
		Event:      event,
		Message:    logMessage,
		Timestamp:  time.Now().Format(time.RFC3339),
		DomainName: from[strings.LastIndex(from, "@")+1:],
	}

	logData, err := json.Marshal(logs)
	if err != nil {
		return fmt.Errorf("error marshaling log data: %v", err)
	}

	return rdb.rdb.Publish(ctx, "bull:email-job-queue:waiting", logData).Err()
}
func NewRedis(rdb *redis.Client) *RedisClient {
	return &RedisClient{rdb: rdb}
}

type Email struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Subject string `json:"subject"`
	Body    string `json:"body"`
}
type SMTPClient struct {
	Host     string
	Port     int
	Username string
	Password string
}

func LookupMX(email string) ([]*net.MX, error) {
	domain := email[strings.LastIndex(email, "@")+1:]
	mxRecords, err := net.LookupMX(domain)
	if err != nil {
		return nil, fmt.Errorf("MX lookup failed: %v", err)
	}

	return mxRecords, nil
}

func SendMail(email Email) error {
	// Lookup MX records
	mxRecords, err := LookupMX(email.To)
	if err != nil || len(mxRecords) == 0 {
		// publishLogs(email.From, "No MX records found")
		return fmt.Errorf("No MX records found")
	}

	// Connect to SMTP server
	for _, mx := range mxRecords {
		addr := mx.Host + ":25"

		log.Printf("Trying to connect to %s: %v", addr, nil)
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			log.Printf("Failed to connect to %s: %v", addr, err)
			continue
		}
		defer conn.Close()

		// Upgrade to TLS (STARTTLS)
		tlsConn := tls.Client(conn, &tls.Config{ServerName: mx.Host})
		client, err := smtp.NewClient(tlsConn, mx.Host)
		if err != nil {
			return fmt.Errorf("failed to create SMTP client: %v", err)
		}
		client.Hello(mx.Host)
		// Send the email
		if err := client.Mail(email.From); err != nil {
			return fmt.Errorf("MAIL FROM command failed: %v", err)
		}
		if err := client.Rcpt(email.To); err != nil {
			return fmt.Errorf("RCPT TO command failed for %s: %v", email.To, err)
		}

		wc, err := client.Data()
		if err != nil {
			return fmt.Errorf("DATA command failed: %v", err)
		}

		msg := fmt.Sprintf("Subject: %s\r\n\r\n%s", "subject", "Hello, this is a test email.")
		_, err = wc.Write([]byte(msg))
		if err != nil {
			return fmt.Errorf("failed to write email body: %v", err)
		}

		wc.Close()
		client.Quit()
		fmt.Println("Email sent via", email.To)
		log.Printf("Email successfully sent to %s via %s", email.To, mx.Host)
		return nil
	}

	return fmt.Errorf("all MX connections failed")
}
func SMTPClients(Host string) error {

	d := mta.Dialer{Host: Host, Port: 587}
	d.TLSConfig = &tls.Config{InsecureSkipVerify: true}

	msg := mta.NewMessage()
	msg.SetAddressHeader("From", "mullayam06@cirrusmail.cloud", "Test MTA Sender")
	msg.SetAddressHeader("To", "su@enjoys.in", "")
	msg.SetHeader("Subject", "Hello!")
	msg.SetHeader("MIME-version: 1.0")
	msg.SetBody("text/plain", "Hello Gophers!")
	if err := d.DialAndSend(msg); err != nil {
		panic(err)
	}
	return nil
}
