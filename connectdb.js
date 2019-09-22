var mysql = require('mysql');

var con = mysql.createPool({
	connectionLimit : 50,
  	host: "localhost",
  	user: "root",
  	password: "",
  	database: "fexchange"
});

module.exports = con;