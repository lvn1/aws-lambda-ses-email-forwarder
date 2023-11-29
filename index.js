"use strict";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";

console.log("AWS Lambda SES Forwarder // @arithmetric // Version 5.0.0");

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
//
// - fromEmail: Forwarded emails will come from this verified address
//
// - subjectPrefix: Forwarded emails subject will contain this prefix
//
// - emailBucket: S3 bucket name where SES stores emails.
//
// - emailKeyPrefix: S3 key name prefix where SES stores email. Include the
//   trailing slash.
//
// - allowPlusSign: Enables support for plus sign suffixes on email addresses.
//   If set to `true`, the username/mailbox part of an email address is parsed
//   to remove anything after a plus sign. For example, an email sent to
//   `example+test@example.com` would be treated as if it was sent to
//   `example@example.com`.
//
// - forwardMapping: Object where the key is the lowercase email address from
//   which to forward and the value is an array of email addresses to which to
//   send the message.
//
//   To match all email addresses on a domain, use a key without the name part
//   of an email address before the "at" symbol (i.e. `@example.com`).
//
//   To match a mailbox name on all domains, use a key without the "at" symbol
//   and domain part of an email address (i.e. `info`).
//
//   To match all email addresses matching no other mapping, use "@" as a key.
var defaultConfig = {
  fromEmail: "noreply@example.com",
  subjectPrefix: "",
  emailBucket: "your-s3-bucket-name",
  emailKeyPrefix: "emailsPrefix/",
  allowPlusSign: true,
  forwardMapping: {
    "info@example.com": [
      "example.john@example.com",
      "example.jen@example.com"
    ],
    "abuse@example.com": [
      "example.jim@example.com"
    ],
    "@example.com": [
      "example.john@example.com"
    ]
  }
};

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function parseEvent(data) {
  // Validate characteristics of a SES event record.
  if (!data.event ||
      !data.event.hasOwnProperty('Records') ||
      data.event.Records.length !== 1 ||
      !data.event.Records[0].hasOwnProperty('eventSource') ||
      data.event.Records[0].eventSource !== 'aws:ses' ||
      data.event.Records[0].eventVersion !== '1.0') {
    return Promise.reject(new Error('Error: Received invalid SES message.'));
  }

  data.email = data.event.Records[0].ses.mail;
  data.recipients = data.event.Records[0].ses.receipt.recipients;
  return Promise.resolve(data);
}

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */

async function transformRecipients(data) {
  const newRecipients = new Set(); // Use a Set for efficient uniqueness checks
  data.originalRecipients = data.recipients;

  for (const origEmail of data.originalRecipients) {
    const origEmailKey = data.config.allowPlusSign
      ? origEmail.toLowerCase().split('+')[0]
      : origEmail.toLowerCase();

    // Check for direct email mappings
    if (data.config.forwardMapping[origEmailKey]) {
      data.config.forwardMapping[origEmailKey].forEach(email => newRecipients.add(email));
      continue; // Skip further checks if a direct mapping is found
    }

    // Check for domain and username mappings
    const [origEmailUser, origEmailDomain] = origEmailKey.split('@');
    if (origEmailDomain && data.config.forwardMapping[`@${origEmailDomain}`]) {
      data.config.forwardMapping[`@${origEmailDomain}`].forEach(email => newRecipients.add(email));
    } else if (origEmailUser && data.config.forwardMapping[origEmailUser]) {
      data.config.forwardMapping[origEmailUser].forEach(email => newRecipients.add(email));
    } else if (data.config.forwardMapping['@']) {
      data.config.forwardMapping['@'].forEach(email => newRecipients.add(email));
    }
  }

  data.recipients = Array.from(newRecipients); // Convert Set back to Array
  return data;
}


/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function fetchMessage(data) {
    // Copying email object to ensure read permission
    const s3Params = {
        Bucket: data.config.emailBucket,
        Key: data.config.emailKeyPrefix + data.email.messageId,
    };

    try {
        const s3Response = await data.s3.send(new GetObjectCommand(s3Params));
        // Stream the S3 object contents
        const stream = s3Response.Body;
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        data.emailData = Buffer.concat(chunks).toString('utf-8');
        return data;
    } catch (error) {
        console.error("Error fetching message from S3:", error);
        throw new Error('Error: Failed to load message body from S3.');
    }
}

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function processMessage(data) {
  var match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
  var header = match && match[1] ? match[1] : data.emailData;
  var body = match && match[2] ? match[2] : '';

  // Add "Reply-To:" with the "From" address if it doesn't already exists
  if (!/^reply-to:[\t ]?/mi.test(header)) {
    match = header.match(/^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/mi);
    var from = match && match[1] ? match[1] : '';
    if (from) {
      header = header + 'Reply-To: ' + from;
    }
  }

  // SES does not allow sending messages from an unverified address,
  // so replace the message's "From:" header with the original
  // recipient (which is a verified domain)
  header = header.replace(
    /^from:[\t ]?(.*(?:\r?\n\s+.*)*)/mgi,
    function(match, from) {
      var fromText;
      if (data.config.fromEmail) {
        fromText = 'From: ' + from.replace(/<(.*)>/, '').trim() +
        ' <' + data.config.fromEmail + '>';
      } else {
        fromText = 'From: ' + from.replace('<', 'at ').replace('>', '') +
        ' <' + data.originalRecipient + '>';
      }
      return fromText;
    });

  // Add a prefix to the Subject
  if (data.config.subjectPrefix) {
    header = header.replace(
      /^subject:[\t ]?(.*)/mgi,
      function(match, subject) {
        return 'Subject: ' + data.config.subjectPrefix + subject;
      });
  }

  // Replace original 'To' header with a manually defined one
  if (data.config.toEmail) {
    header = header.replace(/^to:[\t ]?(.*)/mgi, () => 'To: ' + data.config.toEmail);
  }

  // Remove the Return-Path header.
  header = header.replace(/^return-path:[\t ]?(.*)\r?\n/mgi, '');

  // Remove Sender header.
  header = header.replace(/^sender:[\t ]?(.*)\r?\n/mgi, '');

  // Remove Message-ID header.
  header = header.replace(/^message-id:[\t ]?(.*)\r?\n/mgi, '');

  // Remove all DKIM-Signature headers to prevent triggering an
  // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
  // These signatures will likely be invalid anyways, since the From
  // header was modified.
  header = header.replace(/^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/mgi, '');

  data.emailData = header + body;
  return Promise.resolve(data);
}

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
async function sendMessage(data) {
  var params = {
    Destinations: data.recipients,
    Source: data.originalRecipient,
    RawMessage: {
      Data: Buffer.from(data.emailData)
    }
  };
  return new Promise(function(resolve, reject) {
    data.ses.send(new SendRawEmailCommand(params), function(err, result) {
      if (err) {
        return reject(new Error('Error: Email sending failed.'));
      }
      resolve(data);
    });
  });
}

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} callback - Lambda callback object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
export const handler = async (event, context, callback, overrides) => {
  try {
    let steps = overrides?.steps || [
      parseEvent,
      transformRecipients,
      fetchMessage,
      processMessage,
      sendMessage
    ];

    let data = {
      event,
      context,
      config: overrides?.config || defaultConfig,
      ses: overrides?.ses || new SESClient(),
      s3: overrides?.s3 || new S3Client({ signatureVersion: 'v4' })
    };

    for (const step of steps) {
      data = await step(data);
    }

    console.log("Process finished successfully.");
    callback(null, 'Success');
  } catch (error) {
    console.error("Error in processing:", error);
    callback(error);
  }
};
