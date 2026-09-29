const { Resend } = require("resend");
const dotenv = require("dotenv");
dotenv.config();

const resendClient = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const normalizeEmailPayload = (args) => {
  if (args.length === 1 && args[0] && typeof args[0] === "object") {
    return args[0];
  }

  const [to, subject, cc, html, attachments] = args;
  return { to, subject, cc, html, attachments };
};

const sendEmail = async (...args) => {
  if (!resendClient) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  if (!process.env.RESEND_FROM_EMAIL) {
    throw new Error("RESEND_FROM_EMAIL is not configured.");
  }

  const { to, subject, cc, html, attachments } = normalizeEmailPayload(args);
  const payload = {
    from: process.env.RESEND_FROM_EMAIL,
    to,
    subject,
    html,
  };

  if (cc) payload.cc = cc;
  if (attachments) payload.attachments = attachments;

  const { data, error } = await resendClient.emails.send(payload);

  if (error) {
    throw new Error(error.message);
  }

  return data;
};

module.exports = { sendEmail };
