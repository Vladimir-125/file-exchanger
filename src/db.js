const mysql = require('mysql2/promise');

function createPool(dbConfig) {
	return mysql.createPool({ connectionLimit: 50, ...dbConfig });
}

module.exports = { createPool };
