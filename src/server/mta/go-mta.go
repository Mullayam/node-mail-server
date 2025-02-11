package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"time"

	"net/mail"

	"github.com/redis/go-redis/v9"
	"github.com/rovergulf/mta"
)

type LoggingLevel string
type EmailType string
type LogType string

// Define allowed values as constants
const (
	Alert             LoggingLevel = "alert"
	Crit              LoggingLevel = "crit"
	Error             LoggingLevel = "error"
	Notice            LoggingLevel = "notice"
	Info              LoggingLevel = "info"
	Debug             LoggingLevel = "debug"
	EmailTypeOutgoing EmailType    = "outgoing"
	EmailTypeIncoming EmailType    = "incoming"
)

type IRedisClient struct {
	rdb *redis.Client
}
type BaseLogEntry struct {
	Message    string `json:"message"`
	DomainName string `json:"domain_name"`
	Timestamp  string `json:"timestamp"`
}
type LogMailsEntry struct {
	BaseLogEntry
	Type  LoggingLevel `json:"type"`
	Event string       `json:"event"`
}
type LogEmailEntry struct {
	BaseLogEntry
	Type   EmailType `json:"type"`
	Status string    `json:"status"`
	Email  string    `json:"email"`
}

var ctx = context.Background()
var subscriptionChannel = "OUTGOING_MAILS"

var queue = make(chan string, 1000)

func MakeNewRedisClient(uri string) *IRedisClient {
	client, err := newRedisClient(uri)
	if err != nil {
		log.Fatalf("failed to create Redis client: %v", err)
	}
	return client
}

func newRedisClient(uri string) (*IRedisClient, error) {
	options, err := redis.ParseURL(uri)
	if err != nil {
		return nil, fmt.Errorf("invalid Redis URI: %v", err)
	}

	client := redis.NewClient(options)
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis connection failed: %v", err)
	}

	return &IRedisClient{rdb: client}, nil
}

func main() {

	client := MakeNewRedisClient("rediss://default:AVNS_zI0FrxTBvcV5UqgQnBO@redis-39ff04df-mullayam06.a.aivencloud.com:20348")
	fmt.Println("Connected to Redis")
	sub := client.rdb.Subscribe(ctx, subscriptionChannel)
	status := sub.Ping(ctx)
	fmt.Println("status:", status)
	ch := sub.Channel()

	var wg sync.WaitGroup

	for i := 1; i <= runtime.NumCPU(); i++ {
		wg.Add(1)
		go client.Worker(&wg)
	}

	for msg := range ch {
		select {
		case queue <- msg.Payload:

		default:
			log.Println("queue full")
		}
	}

	close(queue)
	wg.Wait()
}

func (r *IRedisClient) Worker(wg *sync.WaitGroup) {
	defer wg.Done()

	for msg := range queue {
		r.processBatch(msg)
	}
}

func (r *IRedisClient) processBatch(batch string) {

	var emailData Email
	if err := json.Unmarshal([]byte(batch), &emailData); err != nil {
		fmt.Println("error parsing email job data:: %w", err)
	}
	fmt.Println("📧 Processing Email:", emailData.To)
	groupedRecipients := groupRecipientsByDomain(emailData.To)
	for domain, recipients := range groupedRecipients {
		mxRecords, err := r.getValue(domain)
		if err != nil {
			mxRecords, err = LookupMX(domain)
			if err != nil {
				logs := createFormattedLogMessage(LogType(Error), emailData.From, fmt.Sprintf("error getting MX records for domain %s: %s", domain, err.Error()), "SMTP Delivery Error")
				r.publishMailLogs(logs)
			}
			r.setValue(domain, mxRecords)
		}

		for _, recipient := range recipients {
			if err := SendMail(mxRecords, 25, emailData); err != nil {
				logs := createFormattedLogMessage(LogType(Error), emailData.From, fmt.Sprintf("error sending email to %s: %s", recipient, err.Error()), "SMTP Delivery Error")
				r.publishMailLogs(logs)

				r.publisEmailDeliveryLogs(createFormattedLogMessage(LogType(EmailTypeOutgoing), emailData.From, fmt.Sprintf("error sending email to %s: %s", recipient, err.Error()), "SMTP Delivery Error"))
			}
		}

	}

}
func createFormattedLogMessage(logType LogType, email string, message string, extra string) string {
	var logEntry interface{}
	if logType != LogType(EmailTypeIncoming) || logType != LogType(EmailTypeOutgoing) {
		logEntry = LogMailsEntry{
			BaseLogEntry: BaseLogEntry{
				Message:    message,
				Timestamp:  time.Now().Format(time.RFC3339),
				DomainName: email[strings.LastIndex(email, "@")+1:],
			},
			Type:  LoggingLevel(logType),
			Event: extra,
		}
	} else {
		logEntry = LogEmailEntry{
			BaseLogEntry: BaseLogEntry{
				Message:    message,
				Timestamp:  time.Now().Format(time.RFC3339),
				DomainName: email[strings.LastIndex(email, "@")+1:],
			},
			Type:   EmailType(logType),
			Status: extra,
		}
	}

	// Marshal struct to JSON
	logs, err := json.Marshal(logEntry)
	if err != nil {
		log.Fatalf("Failed to marshal logs: %v", err)
	}

	return string(logs)
}
func (r *IRedisClient) publishMailLogs(message string) {

	if err := r.rdb.Publish(ctx, "::channel_for_mail:logs", message).Err(); err != nil {
		log.Printf("Failed to publish step: %v", err)
	}
}
func (r *IRedisClient) publisEmailDeliveryLogs(message string) {

	if err := r.rdb.Publish(ctx, "::email:logs", message).Err(); err != nil {
		log.Printf("Failed to publish step: %v", err)
	}
}
func (r *IRedisClient) getValue(key string) (string, error) {
	val, err := r.rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		return "", nil
	} else if err != nil {
		return "", err
	}
	return val, nil
}

func (r *IRedisClient) setValue(key string, value string) error {
	err := r.rdb.Set(ctx, key, value, 0).Err()
	return err
}

type Email struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	Body    string   `json:"body"`
}
type SMTPClient struct {
	Host     string
	Port     int
	Username string
	Password string
}

func MailParser(rawEmail string) {
	msg, err := mail.ReadMessage(strings.NewReader(rawEmail))
	if err != nil {
		log.Fatal("Error reading email:", err)
	}
	body := new(bytes.Buffer)
	_, err = body.ReadFrom(msg.Body)
	if err != nil {
		log.Fatal("Error reading body:", err)
	}

}
func SendMail(Host string, port int, emailData Email) error {

	d := mta.Dialer{Host: Host, Port: port}
	d.TLSConfig = &tls.Config{InsecureSkipVerify: true}
	s, err := d.Dial()
	if err != nil {
		log.Fatal(err)
	}
	s.Close()

	msg := mta.NewMessage()
	msg.SetAddressHeader("From", emailData.From, "Test MTA Sender")
	for _, to := range emailData.To {
		msg.SetAddressHeader("To", to, "")
	}
	msg.SetHeader("Subject", emailData.Subject)
	msg.SetHeader("MIME-version: 1.0")
	msg.SetBody("text/plain", emailData.Body)
	if err := d.DialAndSend(msg); err != nil {
		panic(err)
	}
	return nil
}

// GOOS=linux GOARCH=amd64 go build -o mta
