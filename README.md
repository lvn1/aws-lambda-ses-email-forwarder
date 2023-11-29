# AWS Lambda SES Email Forwarder (Optimized for Node.js 18.x)

A Node.js script for AWS Lambda that uses the inbound/outbound capabilities of
AWS Simple Email Service (SES) & AWS S3 to run a "serverless" email forwarding service.

## Set up

1. Create a new S3 bucket with default settings: https://s3.console.aws.amazon.com/

2. In your newly created bucket, click on the permissions tab, edit the bucket policy and replace it with the one below:
    - Replace S3-BUCKET-NAME with your actual bucket name and "AWS-ACCOUNT-ID" with your account ID which can be found in the top right, click on your name and copy the account ID
    - (Optional) In the management tab, create a lifecycle rule for this bucket to delete/expire objects after a few days to clean up the stored emails.
 ```
 {
    "Version": "2012-10-17",
    "Statement": [
       {
          "Sid": "GiveSESPermissionToWriteEmail",
          "Effect": "Allow",
          "Principal": {
             "Service": "ses.amazonaws.com"
          },
          "Action": "s3:PutObject",
          "Resource": "arn:aws:s3:::S3-BUCKET-NAME/*",
          "Condition": {
             "StringEquals": {
                "aws:Referer": "AWS-ACCOUNT-ID"
             }
          }
       }
    ]
 }
 ```

3. Go to AWS Lambda, click on create function, author from scratch, give the function a name and select Node.js 18.x as the runtime then click create function at the bottom of the page

4. Copy the index.js file from this repository into the code section of your lambda, replacing whatever is there and then modify the values in this section `var defaultConfig = {`
    - replace the value in fromEmail with your SES verified email or any email from your domain i.e whatever@mydomain.com
    - subjectPrefix can be anything
    - emailBucket needs to be the name as your bucket name
    - emailKeyPrefix can be whatever folder prefix you'd like
    - finally replace the emails in the forward mapping section, ensure your domain is verfied and you can test it out with just one set of emails like so: 
    ```
    forwardMapping: {
         "@example.com": [
            "example.john@example.com"
        ]
    }
    ```
    - The to address, example.john@example.com needs to be verified in SES as well otherwise it won't work
    - Click deploy and the click the actions dropdown in the top right and select publish new version

5. Still in lambda, click on the configuration tab and then under execution role, role name, click the click to your role and it will open in a new tab
    - Click on your permissions policy and it will open yet another tab
    - Click on JSON and then click edit to modify your policy like so and replace the bucket name with your bucket's name:
     ```
        {
            "Version": "2012-10-17",
            "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                ],
                "Resource": "arn:aws:logs:*:*:*"
            },
            {
                "Effect": "Allow",
                "Action": "ses:SendRawEmail",
                "Resource": "*"
            },
            {
                "Effect": "Allow",
                "Action": [
                    "s3:GetObject",
                    "s3:PutObject"
                ],
                "Resource": "arn:aws:s3:::S3-BUCKET-NAME/*"
            }
            ]
        }
    ```
    - Click next to save it and you should see the new resources added in the summary

6. Go to AWS SES, click on verified identities and ensure you have some verified domains or emails, if not, click create identity
    - Once you've verified your identity, click on Email Receiving
    - Create a new rule set and name it
    - Create a new rule, give it a name and go to step 3, 
    - Add new action, Deliver to S3 bucket
    - Find your bucket in the search box
    - Add your Object key prefix for the folder you would like to use and make sure it's the same as the emailKeyPrefix you specified in lambda
    - Add another action, Invoke lambda function and select your function in the dropdown
    - If you are prompted by SES to add permissions to access `lambda:InvokeFunction`, click agree
    - Click next to save it

7. If you're sending from a domain you will also need to add in an MX record according to your region, go to AWS Route 53
    - Click on hosted zones and click on your domain
    - Create a record, record type MX and then in value add the AWS SMTP link according to your region, i.e 10 inbound-smtp.us-east-1.amazonaws.com
    - Click create records
    - See [SES documentation](http://docs.aws.amazon.com/ses/latest/DeveloperGuide/regions.html#region-endpoints)

8. It should be working, try sending an email to your domain which you've specified in forward mapping

## Limitations

- SES only allows sending email from addresses or domains that are verified.
Since this script is meant to allow forwarding email from any sender, the
message is modified to allow forwarding through SES and reflect the original
sender. This script adds a Reply-To header with the original sender, but the
From header is changed to display the original sender but to be sent from the
original destination.

  For example, if an email sent by `Jane Example <jane@example.com>` to
  `info@example.com` is processed by this script, the From and Reply-To headers
  will be set to:

  ```
  From: Jane Example at jane@example.com <info@example.com>
  Reply-To: jane@example.com
  ```

  To override this behavior, set a verified fromEmail address
  (e.g., noreply@example.com) in the `config` object and the header will look
  like this.

  ```
  From: Jane Example <noreply@example.com>
  Reply-To: jane@example.com
  ```

- SES only allows receiving email sent to addresses within verified domains. For
more information, see:
http://docs.aws.amazon.com/ses/latest/DeveloperGuide/verify-domains.html

- SES only allows sending emails up to 10 MB in size (including attachments
after encoding). See:
https://docs.aws.amazon.com/ses/latest/DeveloperGuide/limits.html

- Initially SES users are in a sandbox environment that has a number of
limitations. See:
http://docs.aws.amazon.com/ses/latest/DeveloperGuide/limits.html

## Troubleshooting

Test the configuration by sending emails to recipient addresses.

- If you receive a bounce from AWS with the message `"This message could not be
delivered due to a recipient error."`, then the rules could not be executed.
Check the configuration of the rules.

- Check if you find an object associated with the message in the S3 bucket.

- If your Lambda function encounters an error it will be logged
in CloudWatch. Click on "Logs" in the CloudWatch menu, and you should find a log
group for the Lambda function.

## Credits

Based on the work of @arithmetric from:
https://github.com/arithmetric/aws-lambda-ses-forwarder/
