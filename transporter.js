var nodemailer = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var transporter = nodemailer.createTransport(smtpTransport({
  service: 'gmail',
  auth: {
    user: 'wdevelopment125@gmail.com',
    pass: process.env.PASSWD
  }
}));


module.exports = transporter;