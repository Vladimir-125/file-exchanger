const nodemailer = require('nodemailer');

// Returns an object with sendMail(options) -> Promise.
// Without credentials, emails are only logged to the console.
function createMailer({ user, pass }) {
	if (!user || !pass) {
		console.warn('EMAIL/PASSWD not set; confirmation emails will be printed to the console.');
		return {
			async sendMail(options) {
				console.log(`[mail to ${options.to}] ${options.subject}\n${options.text}`);
			}
		};
	}
	const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
	return {
		sendMail: (options) => transporter.sendMail({ from: user, ...options })
	};
}

module.exports = { createMailer };
