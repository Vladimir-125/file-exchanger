// call all the required packages
const express = require('express')
const bodyParser= require('body-parser')
const multer = require('multer');
const fs = require('fs');
const rimraf = require("rimraf");
// mysql connection to db
var connectionPool = require('./connectdb');
// express app
const app = express();
const crypto = require('crypto');

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

app.get('/secure', function(req, res) {
    res.sendFile(__dirname + '/send-file-with-password.html');  
});

// send static files for user
app.use(express.static( __dirname + "/public"));


// storage defines where the file shoul be stored
// destination is used to determine within which folder the uploaded files should be stored.
// cb 
// filename is used to determine what the file should be named inside the folder.
var storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, createDir());
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
})
 
var upload = multer({ storage: storage }).single('file');

app.post('/uploadfile',  (req, res) => {
  upload(req,res,function(err) {
        if(err) {
            return res.end("Error uploading file.");
        }

        const index = idDB.findIndex(obj => obj.file_id==id);

		if(req.body.password){
			// get password hash
			const hash = crypto.createHash('sha256').update(req.body.password).digest('hex'); // temp value
			idDB[index].password_hash = hash; 
		}

		// insert in db
		let sql = 'insert into files values(' + idDB[index].file_id + ',\'' + idDB[index].creation_date + '\',\'' + idDB[index].password_hash + '\');';
		connectionPool.query(sql, function (err, result) {
			if (err) throw err;
		});

        // return download key and server store time
		res.json({'key':id,'time':storeTime});

    });
});

app.post('/validate', function(req, res) {
	const req_key = req.body.key;
    const passwd =  req.body.password;
    const index = idDB.findIndex(obj => obj.file_id == req_key);

    // if file exist, get index of the file
    if(index >= 0){
    	// if file id in db
    	if(idDB[index].password_hash != ''){
    		// if file has a password
    		if(passwd==undefined){
    			res.end('enc');
    		}else{
    			const passhash = crypto.createHash('sha256').update(passwd).digest('hex');
    			if(idDB[index].password_hash == passhash){
    				res.end('ok');
    			}else{
    				// wrong password
    				res.end('wrongpass');
    			}
    		}
    	}else{
    		// file does not has a password
    		res.end('ok');
    	}
    }else{
    	// if file id is not in db
    	res.end('isnx');

    }
});

app.post('/download', function(req, res) {
    
    const req_key = req.body.key;
    const passwd =  req.body.password;
    const index = idDB.findIndex(obj => obj.file_id == req_key);
    console.log(req_key)
    console.log(req.body)
    // if file exist, get index of the file
    if(index >= 0){
    	// if file id in db
    	if(idDB[index].password_hash != ''){
    		// if file has a password
    		console.log('req.body.password: ' + passwd);
    		if(passwd==undefined){
    			res.end('Enter password');
    		}else{
    			const passhash = crypto.createHash('sha256').update(passwd).digest('hex');
    			if(idDB[index].password_hash == passhash){
    				console.log('File has been send!')
    				var folder = './uploads/' + req_key;
					fs.readdir(folder, (err, files) => {
						// files has names of all the files.
						// download first file from the folder
						res.download(folder + '/' + files[0]);
						// TODO: add download all the content in the folder in one link  
					}); 
    			}else{
    				// wrong password
    				res.end('<script>alert(\'Wrong password!\')</script>');
    			}
    		}
    	}else{
    		// file does not has a password
    		console.log('File does not have a password!')
    	}
    }else{
    	// if file id is not in db
    	console.log('File does not exist')

    }

	if(idDB.filter(obj => obj.file_id == req_key).length > 0){
		// id folder with the file
		var folder = './uploads/' + req_key;
		fs.readdir(folder, (err, files) => {
			// files has names of all the files.
			// download first file from the folder
			res.download(folder + '/' + files[0]);
			// TODO: add download all the content in the folder in one link  
		}); 
	}
	else{
		//set the appropriate HTTP header
  		//res.setHeader('Content-Type', 'text/html');
		//res.status(404);
		//res.sendFile(__dirname + '/statics/fileNotFound.html');  
		res.send('File is not found!')
		//res.write('<script>alert(\'Invalid key!\')</script>');
		//res.write('<script>window.history.back()</script>');
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
		// if created an id that doesn't exist in the db
		if(!idDB.filter(obj => obj.file_id==id).length > 0){
			let file = {};
			file.file_id = id;
			file.creation_date = currentDateTime();
			file.password_hash = '';

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