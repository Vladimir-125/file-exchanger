// call all the required packages
const express = require('express');
const bodyParser= require('body-parser');
const multer = require('multer');
const fs = require('fs');
// remove file directory
const rimraf = require("rimraf");
// mysql connection to db
const connectionPool = require('./connectdb');
const transporter = require('./transporter');
const cookieParser = require('cookie-parser'); // store cookie to clients machine
const session = require('express-session'); // login confirmation
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

const emailSendingServer = 'wdevelopment125@gmail.com';

const protocol = 'http://';

// config parameters <------------------------------------------------


// init process ----------------------------------------------------->

// load database on the server
connectionPool.query('select * from files', function (err, result){
	if (err) throw err;
		idDB = result;

	console.log('Database has beed loaded on the server!');
});

app.use(bodyParser.urlencoded({extended: true}));

// initialize cookie-parser to allow us access the cookies stored in the browser. 
app.use(cookieParser());

// initialize express-session to allow us track the logged-in user across sessions.
app.use(session({secret: "Secret key protecter string",
   				key: 'user_sid',
				resave: false,
			    saveUninitialized: true,
			    cookie: {
			    	// expires in an hour
			        expires: 600000
			    }
}));

var loginChecker = (req, res, next) => {
    if (!req.session.logged) {
        res.redirect('/');
    } else {
        next();
    }    
};

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

app.get('/secure', loginChecker, function(req, res) {
    res.sendFile(__dirname + '/send-file-with-password.html');  
});

app.get('/signup', function(req, res) {
    res.sendFile(__dirname + '/statics/signup.html');  
});


app.post('/signup', function(req, res) {
	const uname = req.body.uname;
	const uemail = req.body.uemail.toLowerCase();
	const upassword = req.body.upassword;
	const salt = randHex(16);
	const upasswordhash = crypto.createHash('sha256').update(salt+upassword).digest('hex');
	const confirm_url = crypto.createHash('sha256').update(salt+uemail).digest('hex');
	// check if email is already exist

	checkEmail(uemail).then(function(result){
		if(result.length>0){
			// this user is already in db
			res.end('You have been already signed up before!');

		}else{
			// new user
			let sql = `insert into \`not_confirmed\` (\`name\`, \`email\`,\`salt\`, \`password_hash\`, \`confirm_url\`) values('${uname}','${uemail}','${salt}','${upasswordhash}', '${confirm_url}')`;
			connectionPool.query(sql, function (err, result){
				if (err) throw err;
			});

			let emailText = `Thank you for subscribing on Send me file.
From now on you can use your email to login to our system.
Just folow the link to confirm signup: ${protocol+req.headers.host+'/confirm/'+confirm_url}`;
			var mailOptions = {
			  from: emailSendingServer,
			  to: uemail,
			  subject: 'Welcome to Send me File',
			  text: emailText 
			};

			transporter.sendMail(mailOptions, function(error, info){
			  if (error) {
			    console.log(error);
			  } else {
			    console.log('Email sent: ' + info.response);
			  }
			});

			res.end('Welcome new user! Please confirm your email!');
		}	
		
	}).catch((err)=>setImmediate(()=>{throw err;}));
});

function checkEmail(email){
	return new Promise(function(resolve, reject){
		const sql = `select * from users where email='${email}'`;	
		connectionPool.query(sql, function (err, result){
		if (err){
			return reject(err);
		};
		resolve(result);
		});
	});
}


app.get('/confirm/:token', (req, res)=>{
	const token = req.params.token;
	getUnconfirmedUser(token).then(function(result){
		if(result.length>0){
			// right token

			// insert into users table
			const insertSql = `insert into users(\`name\`, \`email\`,\`salt\`, \`password_hash\`) values('${result[0].name}','${result[0].email}','${result[0].salt}','${result[0].password_hash}')`;

			connectionPool.query(insertSql, function (err, result){
				if (err) throw err;
			});

			// delete from not confirmed table
			const deleteSql = `delete from not_confirmed where confirm_url=\'${token}\'`;
			
			connectionPool.query(deleteSql, function (err, result){
				if (err) throw err;
			});
			res.end('You have successfully confirmed your email address!');
		}else{
			// wrong toket
			res.status(404);        // HTTP status 404: NotFound
			res.sendFile(__dirname + '/statics/pagenotfound.html'); 
		}
	}).catch((err)=>setImmediate(()=>{throw err;}));
});

function getUnconfirmedUser(token){
	return new Promise(function(resolve, reject){
		const sql = `select * from not_confirmed where confirm_url=\'${token}\'`;	
		connectionPool.query(sql, function (err, result){
		if (err){
			return reject(err);
		};
		resolve(result);
		});
	});
}


// send static files for user
app.use(express.static( __dirname + "/public"));



// storage defines where the file shoul be stored
// destination is used to determine within which folder the uploaded files should be stored.
// cb 
// filename is used to determine what the file should be named inside the folder.
var storage = multer.memoryStorage()
 
var upload = multer({ storage: storage });

app.post('/login', (req, res)=>{
	const email = req.body.email.toLowerCase();
	const sql = `select * from users where email='${email}'`;
	connectionPool.query(sql, function (err, result){
		if (err) throw err;
			if(result.length>0){
				const passwordHash = crypto.createHash('sha256').update(result[0].salt+req.body.password).digest('hex'); // temp value
				if(passwordHash===result[0].password_hash){
					req.session.logged = true;
					req.session.userName = result[0].name;
					req.session.userId = result[0].id;
					req.session.userEmail = result[0].email;
					res.redirect('/secure');
				}else{
					// wrong password
					res.end('Wrong email or password!');
				}
							
			}else{
				// wrong email
				res.end('Wrong email or password!');				
			}
	});
});

app.post('/name', loginChecker, (req, res)=>{
	res.end(req.session.userName);
});

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

function randHex(len) {
var maxlen = 8,
      min = Math.pow(16,Math.min(len,maxlen)-1) 
      max = Math.pow(16,Math.min(len,maxlen)) - 1,
      n   = Math.floor( Math.random() * (max-min+1) ) + min,
      r   = n.toString(16);
  while ( r.length < len ) {
     r = r + randHex( len - maxlen );
  }
  return r;
};

app.listen(port, ()=>{
	console.log('Running at Port: ' + port);
});