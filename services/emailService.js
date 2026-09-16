const resend = require("resend");
const pool = require("../config/db_connection");
const dotenv = require("dotenv");
dotenv.config();

const resendClient = new resend.Resend(process.env.RESEND_API_KEY);





const sendEmail = async (to,subject,cc,html,attachments) => {
     const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to,
    cc,
    subject,
    html,
    attachments,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

module.exports = { sendEmail };
