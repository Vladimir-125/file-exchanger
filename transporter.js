var nodemailer = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var transporter = nodemailer.createTransport(smtpTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL,
    pass: process.env.PASSWD
  }
}));


module.exports = transporter;