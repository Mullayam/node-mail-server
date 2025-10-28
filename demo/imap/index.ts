import Imap from 'node-imap'
const eml = `Return-Path: <sender@example.com>
Delivered-To: recipient@testdomain.com
Received: from mail.example.com (mail.example.com [192.0.2.1])
	by mx.testdomain.com (Postfix) with ESMTPS id 5A3B2C01F4
	for <recipient@testdomain.com>; Sat, 18 Oct 2025 14:23:45 +0000 (UTC)
Received: from client.example.com ([198.51.100.42])
	by mail.example.com with ESMTPSA id abc123.456.789
	(version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384);
	Sat, 18 Oct 2025 14:23:44 +0000
Date: Sat, 18 Oct 2025 14:23:42 +0000
From: John Doe <sender@example.com>
To: Jane Smith <recipient@testdomain.com>
Cc: team@example.com
Subject: Test Email with RFC Compliance
Message-ID: <20251018142342.abc123@example.com>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="----=_Part_12345_67890.1234567890"
Content-Transfer-Encoding: 7bit
X-Mailer: CustomMailClient/1.0
X-Priority: 3
Reply-To: John Doe <sender@example.com>
In-Reply-To: <previous-message-id@testdomain.com>
References: <original-message-id@testdomain.com> <previous-message-id@testdomain.com>

------=_Part_12345_67890.1234567890
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

Hello Jane,

This is a test email formatted according to RFC 5322 standards. It demons=
trates proper email structure including:

- Multiple header fields
- MIME multipart content
- Proper encoding
- Thread references

Best regards,
John Doe

------=_Part_12345_67890.1234567890
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

<!DOCTYPE html>
<html>
<head>
<meta charset=3D"UTF-8">
</head>
<body>
<p>Hello Jane,</p>

<p>This is a <strong>test email</strong> formatted according to RFC 5322 =
standards. It demonstrates proper email structure including:</p>

<ul>
<li>Multiple header fields</li>
<li>MIME multipart content</li>
<li>Proper encoding</li>
<li>Thread references</li>
</ul>

<p>Best regards,<br>
John Doe</p>
</body>
</html>

------=_Part_12345_67890.1234567890--`
var imap = new Imap({

  user: "user1@example.com",
  password: "pass",
  host: 'localhost',
  port: 143,
  tls: false,
  debug(info) {
    console.log(info)
  },

});
imap.once('ready', function () {
  imap.getBoxes(function (err, boxes) {
    if (err) throw err;
    console.log('Mailboxes:', boxes);

    imap.openBox('Spam', false, function (err, box) {
      if (err) throw err;
      console.log("Opened box:", box);
      if (box.messages.total === 0) {
        console.log("No messages in inbox. Appending a test message.");
        // imap.append(eml, { mailbox: 'INBOX', flags: ['\\Seen'] },
        //   function (err) {
        //     if (err) throw err;
        //     console.log('Message appended!');
        //   }
        // );

      }
      // imap.seq.fetch(box.messages.total === 0 ? "*" : box.messages.total + ':*', { bodies: '' })
      //   .on('message', function (msg, seqno) {

      //     // msg.on('body', function (stream, info) {
      //     //   let buffer = '';
      //     //   stream.on('data', function (chunk) {
      //     //     buffer += chunk.toString();
      //     //   });
      //     //   stream.once('end', function () {
      //     //     console.log('Message', seqno, 'body', buffer);
      //     //   });
      //     // });

      //   }).on('error', function (err) {
      //     console.log('Error fetching messages:', err);
      //   });
      //   // imap.end();
    });
  });

});
imap.once('mail', num => console.log("New mail:", num))
imap.once('error', function (err) {
  console.log(err);
});

imap.once('end', function () {
  console.log('Connection ended');
});

imap.connect();