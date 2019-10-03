// call all the required packages
const express = require('express')
const bodyParser= require('body-parser')
const multer = require('multer');
const fs = require('fs');
// remove file directory
const rimraf = require("rimraf");
// mysql connection to db
const connectionPool = require('./connectdb');
// express app
const app = express();

// file encryption
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const stream = require('stream');
const AppendInitVect = require('./appendInitVect');
const mime = require('mime');

// local variables
//var id;
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
var storage = multer.memoryStorage()
 
var upload = multer({ storage: storage });


app.post('/uploadfile', upload.single('file'), (req, res, next) => {
  const file = req.file;
  if (!file) {
  	// file has not been sent
    const error = new Error('Please upload a file');
    error.httpStatusCode = 400;
    return next(error);
  }
  else{
  	// create file id and creation date
	const fdata = createMetadata();

  	// choose storage method
  	if(req.body.password){
  		encrypt(file.buffer, file.originalname, req.body.password, fdata);
  		// get password hash
		const hash = crypto.createHash('sha256').update(req.body.password).digest('hex'); // temp value
		fdata.password_hash = hash;
  	}else{
  		//encrypt encrypt and stores file
  		storeBuffer(file.buffer, file.originalname, fdata);
  	}

  	// TODO: return file object instead of simply putting it
  	//const index = idDB.findIndex(obj => obj.file_id==id);

 //  	// redu id transfer method
	// if(req.body.password){
	// 	// get password hash
	// 	const hash = crypto.createHash('sha256').update(req.body.password).digest('hex'); // temp value
	// 	fdata.password_hash = hash; 
	// }

  	// insert in db
  	idDB.push(fdata);
	let sql = 'insert into files values(' + fdata.file_id + ',\'' + fdata.creation_date + '\',\'' + fdata.password_hash + '\');';
	connectionPool.query(sql, function (err, result) {
		if (err) throw err;
	});

    // return download key and server store time
	res.json({'key':fdata.file_id,'time':storeTime});
  }
})

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
    // if file exist, get index of the file
    console.log('Entered download');
    if(index >= 0){
    	// if file id in db
    	if(idDB[index].password_hash != ''){
    		// if file has a password
    		if(passwd==undefined){
    			res.end('Enter password');
    		}else{
    			const passhash = crypto.createHash('sha256').update(passwd).digest('hex');
    			if(idDB[index].password_hash == passhash){
    				var folder = './uploads/' + req_key;
					fs.readdir(folder, (err, files) => {
						// files has names of all the files.
						// download first file from the folder
						const file = folder + '/' + files[0];
						decrypt(file, passwd, res);
						// TODO: add download all the content in the folder in one link  
					}); 
    			}else{
    				// wrong password
    				res.end('<script>alert(\'Wrong password!\')</script>');
    			}
    		}
    	}else{
    		console.log('Start download');
    		// file does not has a password
    		var folder = './uploads/' + req_key;
				fs.readdir(folder, (err, files) => {
					// files has names of all the files.
					// download first file from the folder
					res.download(folder + '/' + files[0]);
					// TODO: add download all the content in the folder in one link  
				}); 
    	}
    }else{
    	// if file id is not in db
    	res.end('<script>alert(\'File does not exist!\');document.location.href="/";</script>');
    }

});

app.get('/download', (req, res)=>{
	const req_key = req.query.key;
	const index = idDB.findIndex(obj => obj.file_id == req_key);
    // if file exist, get index of the file
    if(index >= 0){
    	// if file id in db
    	if(idDB[index].password_hash != ''){
    		//if file has a password
    		//get password...
    		let script = `
						<!DOCTYPE html>
						<html>
						<head>
						</head>
						<body>
							<script>
								var form = document.createElement("form");                 
								var key = document.createElement("input");                 
								var pass = document.createElement("input");
								key.value = ${req_key};
								pass.value = prompt('Enter password:');
								key.setAttribute('name', 'key');
								key.style.visibility = "hidden";
								pass.style.visibility = "hidden";
								pass.setAttribute('name', 'password');                
								form.setAttribute('method', 'post');
								form.setAttribute('action', '/download');
								form.appendChild(key);                              
								form.appendChild(pass);                              
								document.body.appendChild(form).submit();
								setTimeout(()=>{document.location.href="/";}, 1000);
							</script>
						</body>
						</html>
    					`;
    		res.end(script);
    	}else{
    		// file does not has a password
    		var folder = './uploads/' + req_key;
				fs.readdir(folder, (err, files) => {
					// files has names of all the files.
					// download first file from the folder
					res.download(folder + '/' + files[0]);
					// TODO: add download all the content in the folder in one link  
				}); 
    	}
    }else{
    	// if file id is not in db
    	res.end('<script>alert(\'File does not exist!\');document.location.href="/";</script>');
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

function createDir(fdata){
	// create directory
	var dir = './uploads/' + fdata.file_id;
	if (!fs.existsSync(dir)){
	    fs.mkdirSync(dir);
	}
	return 'uploads/' + fdata.file_id.toString();
}

function createMetadata(){
	while(true){
		// create id
		let id = Math.floor(Math.random() * 9 * Math.pow(10, keyLen-1) + 1 * Math.pow(10, keyLen-1));    
		// if created an id that doesn't exist in the db
		if(!idDB.filter(obj => obj.file_id==id).length > 0){
			let fileInfo = {};
			fileInfo.file_id = id;
			fileInfo.creation_date = currentDateTime();
			fileInfo.password_hash = '';

			return fileInfo;
		}
	}
}

function currentDateTime(){
	// prepare date string 'YYYY-MM-DD HH-MM-SS'
	var d = new Date();
	return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds();
}


function encrypt(file, name, password, fdata) {
	// Generate a secure, pseudo random initialization vector.
	const initVect = crypto.randomBytes(16);
	var readStream = new stream.PassThrough();

	// Write your buffer
	readStream.end(file);

	// Pipe it to something else  (i.e. stdout)
	// Generate a cipher key from the password.
	const CIPHER_KEY = getCipherKey(password);
	//const readStream = file;
	const gzip = zlib.createGzip();
	const cipher = crypto.createCipheriv('aes256', CIPHER_KEY, initVect);
	const appendInitVect = new AppendInitVect(initVect);
	// Create a write stream with a different file extension.
	const writeStream = fs.createWriteStream(path.join( createDir(fdata) + '/' + name + ".enc"));

	readStream
		.pipe(gzip)
		.pipe(cipher)
		.pipe(appendInitVect)
		.pipe(writeStream);
}

function decrypt(file, password, res) {
	// First, get the initialization vector from the file.
	const readInitVect = fs.createReadStream(file, { end: 15 });

	let initVect;
	readInitVect.on('data', (chunk) => {
	initVect = chunk;
	});

	// Once we’ve got the initialization vector, we can decrypt the file.
	readInitVect.on('close', () => {
		const cipherKey = getCipherKey(password);
		const readStream = fs.createReadStream(file, { start: 16 });
		const decipher = crypto.createDecipheriv('aes256', cipherKey, initVect);
		const unzip = zlib.createUnzip();

		// remove .enc part
		file = file.substr(0, file.length-4);

		var filename = path.basename(file);
		var mimetype = mime.getType(file);

		res.setHeader('Content-disposition', 'attachment; filename=' + filename);
		res.setHeader('Content-type', mimetype);

		readStream
		  	.pipe(decipher)
		  	.pipe(unzip)
		  	.pipe(res);
	});
}

function storeBuffer(buffer, fname, fdata){
	var readStream = new stream.PassThrough();

	// Write your buffer
	readStream.end(buffer);

	const writeStream = fs.createWriteStream(path.join( createDir(fdata) + '/' + fname));

	readStream.pipe(writeStream);
}

function getCipherKey(password) {
  return crypto.createHash('sha256').update(password).digest();
}


app.listen(port, ()=>{
	console.log('Running at Port: ' + port);
});