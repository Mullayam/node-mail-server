package filing

import "testing"

func TestDecide(t *testing.T) {
	rules := Rules{SpamMailbox: "Junk", SpamHeaders: []string{"X-AE-Spam-Flag", "X-Spam-Flag"}}
	cases := []struct {
		name, msg, want string
	}{
		{"clean", "Subject: hi\r\n\r\nbody", "INBOX"},
		{"node tag", "X-AE-Spam-Flag: YES\r\nSubject: hi\r\n\r\nbody", "Junk"},
		{"lower case and spaces", "x-ae-spam-flag:   yes \r\n\r\nbody", "Junk"},
		{"spamassassin style", "X-Spam-Flag: YES, score=7.1\r\n\r\nbody", "Junk"},
		{"explicit no", "X-Spam-Flag: NO\r\n\r\nbody", "INBOX"},
		{"flag only in the body", "Subject: hi\r\n\r\nX-AE-Spam-Flag: YES", "INBOX"},
		{"folded header", "X-AE-Spam-Flag:\r\n YES\r\n\r\nbody", "Junk"},
	}
	for _, c := range cases {
		if got := Decide([]byte(c.msg), rules).Mailbox; got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	if got := Decide([]byte("X-AE-Spam-Flag: YES\r\n\r\n"), Rules{SpamMailbox: "INBOX"}).Mailbox; got != "INBOX" {
		t.Errorf("spam-mailbox=INBOX should keep spam in INBOX, got %s", got)
	}
}

func TestOutboxStage(t *testing.T) {
	cases := map[string]OutboxStage{
		"X-AE-Outbox: queued\r\nSubject: x\r\n\r\nb": OutboxQueued,
		"x-ae-outbox:  SENT \r\n\r\nb":               OutboxSent,
		"X-AE-Outbox: maybe\r\n\r\nb":                NotOutbox,
		"Subject: x\r\n\r\nX-AE-Outbox: sent":        NotOutbox,
	}
	for in, want := range cases {
		if got := Outbox([]byte(in)); got != want {
			t.Errorf("Outbox(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStripHeader(t *testing.T) {
	cases := []struct{ in, want string }{
		{"X-AE-Outbox: queued\r\nSubject: hi\r\n\r\nbody\r\n", "Subject: hi\r\n\r\nbody\r\n"},
		{"Subject: hi\r\nx-ae-outbox: sent\r\n folded\r\n\tmore\r\nTo: a@b\r\n\r\nX-AE-Outbox: in body\r\n", "Subject: hi\r\nTo: a@b\r\n\r\nX-AE-Outbox: in body\r\n"},
		{"Subject: hi\n\nbody", "Subject: hi\n\nbody"},
		{"X-AE-Outboxed: keep\r\n\r\n", "X-AE-Outboxed: keep\r\n\r\n"},
	}
	for _, c := range cases {
		if got := string(StripHeader([]byte(c.in), OutboxHeader)); got != c.want {
			t.Errorf("StripHeader(%q)\n got  %q\n want %q", c.in, got, c.want)
		}
	}
}
