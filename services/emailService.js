const { Resend } = require("resend");
const dotenv = require("dotenv");
dotenv.config();

let resendClient;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured.');
  }

  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }

  return resendClient;
}

const sendEmail = async ({ to, subject, html, cc, attachments }) => {
  if (!process.env.RESEND_FROM_EMAIL) {
    throw new Error('RESEND_FROM_EMAIL is not configured.');
  }

  const payload = {
    from: process.env.RESEND_FROM_EMAIL,
    to,
    subject,
    html,
  };

  if (cc) payload.cc = cc;
  if (attachments) payload.attachments = attachments;

  const { data, error } = await getResendClient().emails.send(payload);

  if (error) {
    throw new Error(error.message);
  }

  return data;
};

module.exports = { sendEmail };
