// call all the required packages
const express = require('express')
const bodyParser= require('body-parser')
const multer = require('multer');
var fs = require('fs');
var rimraf = require("rimraf");
// mysql connection to db
var connectionPool = require('./connectdb');
// express app
const app = express();

// local variables
var id;
var idDB = []; // local database

// config parameters ----------------------------------------------->

const secInterval = 1;
// file storage time
const storeMinutes = 1;
const storeHours = 0;
const storeTime = '00:01:00';
// file key length
const keyLen = 4;
const port = process.env.PORT || 3000;

// config parameters <------------------------------------------------


// init process ----------------------------------------------------->

// load database on the server
connectionPool.query('select * from files', function (err, result){
	if (err) throw err;
		idDB = result;

	console.log('Database has beed loaded on the server!');
});

app.use(bodyParser.urlencoded({extended: true}));

// set interval how often to delete
setInterval(function(){
	 for(let i = 0; i < idDB.length; i++){
	 	deleteOld(idDB[i]);
	 }
}, secInterval*1000);

// init process <------------------------------------------------------


// root directory
app.get('/', function(req, res) {
    res.sendFile(__dirname + '/send-file.html');  
});

// send static files for user
app.use(express.static( __dirname + "/public"));


// storage defines where the file shoul be stored
// destination is used to determine within which folder the uploaded files should be stored.
// cb 
// filename is used to determine what the file should be named inside the folder.
var storage = multer.diskStorage({
  destination: function (req, file, cb) { 
    cb(null, createDir())
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname)
  }
})
 
var upload = multer({ storage: storage }).single('file');

app.post('/uploadfile',  (req, res) => {
  upload(req,res,function(err) {
        if(err) {
            return res.end("Error uploading file.");
        }

        // return download key and server store time
		res.json({'key':id,'time':storeTime});

    });
});

app.get('/download', function(req, res) {
	if(idDB.filter(obj => obj.file_id == req.query.fileId).length > 0){
		// id folder with the file
		var folder = './uploads/' + req.query.fileId;
		fs.readdir(folder, (err, files) => {
			// files has names of all the files.
			// download first file from the folder
			res.download(folder + '/' + files[0]);
			// TODO: add download all the content in the folder in one link  
		}); 
	}
	else{
		//set the appropriate HTTP header
  		res.setHeader('Content-Type', 'text/html');
		res.status(404);
		//res.sendFile(__dirname + '/statics/fileNotFound.html');  
		res.write('<script>alert(\'Invalid key!\')</script>');
		res.write('<script>window.history.back()</script>');
		//end the response process
 		res.end();
	}
});


function deleteOld(file){
	const min = storeMinutes;
	const hours = storeHours;
	// waiting time in seconds
	let waitTime = 0; 
	
	if(min>0)
		waitTime += min*60;
	if(hours>0)
		waitTime += hours*60*60;
	
	const creationTime = new Date(file.creation_date);
	const currenTime = new Date();
	let dif = currenTime.getTime() - creationTime.getTime();
	let totalSeconds = Math.floor(dif/1000);

	if(totalSeconds > waitTime){
		//console.log('File has been on the server ' + totalSeconds + ' seconds.');
		rimraf("./uploads/" + file.file_id, function () { 
			console.log('File has beed deleted!'); 
		});
		connectionPool.query('DELETE FROM files WHERE file_id =' + file.file_id, function (err, result){
			if (err) throw err;
		});
		let index = idDB.indexOf(file);
		if (index > -1) {
 			idDB.splice(index, 1);
		}
	}
}

function createDir(){
	// create file id and creation date
	createMetadata();
	// create directory
	var dir = './uploads/' + id;
	if (!fs.existsSync(dir)){
	    fs.mkdirSync(dir);
	}
	return 'uploads/' + id.toString();
}

function createMetadata(passwd){
	while(true){
		// create id
		id = Math.floor(Math.random() * 9 * Math.pow(10, keyLen-1) + 1 * Math.pow(10, keyLen-1));    

		if(!idDB.filter(obj => obj.file_id==id).length > 0){
			let file = {};
			file.file_id = id;
			file.creation_date = currentDateTime();
			if(passwd==null){
				file.password_hash = '';
			}
			else{
				file.password_hash = passwd;
			}
			let sql = 'insert into files values(' + file.file_id + ',\'' + file.creation_date + '\',\'' + file.password_hash + '\');';
			connectionPool.query(sql, function (err, result) {
    			if (err) throw err;
  			});
			idDB.push(file);
			break;
		}
	}
}

function currentDateTime(){
	// prepare date string 'YYYY-MM-DD HH-MM-SS'
	var d = new Date();
	return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds();
}

app.listen(port, ()=>{
	console.log('Running at Port: ' + port);
});