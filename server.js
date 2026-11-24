const config = require('./src/config');
const { createPool } = require('./src/db');
const { createMailer } = require('./src/mailer');
const { createFileStore } = require('./src/fileStore');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { createApp } = require('./src/app');

async function main() {
	const db = createPool(config.db);
	const store = createFileStore({ ...config, db });
	await store.load();
	console.log('Database has been loaded on the server!');

	setInterval(() => store.deleteExpired(), config.cleanupIntervalMs).unref();
	store.deleteExpired();

	const sessionStore = new MySQLStore({ ...config.db, createDatabaseTable: true });
	const app = createApp({ db, store, mailer: createMailer(config.mail), config, sessionStore });
	app.listen(config.port, () => console.log('Running at Port: ' + config.port));
}

main().catch((err) => {
	console.error('Failed to start:', err.message);
	process.exit(1);
});
