# Send me file

“Send me file” aims to provide another better and more comfortable way for sending and receiving files between various devises. This platform provides both web and desktop application, so that clients would be able to send and receive any type of files. Users can send files from any device to any other device. There is two ways of sending a file. 

First, allows you to quickly send any file to the server which stores it some specific amount of time . The server then provides digital key to be used to download the file. It also provides QR code that can be used to download file. QR code has a direct link to download the file.

Second, is secure method. It allows users to send files adding a password to them. The files are sent to the server on a secure https channel and stored in encrypted state on the server. The password used for encrypting the file deleted form the server immediately after encryption. The users are prompted to enter the proper password as well as the key of the file in order to download the file. The system is able to check if user enters the right password. When users follow the link encrypted in QR code, they still prompted to enter the password in case the file was encrypted. 

First simple method does not need any registration process, and anyone can send and receive files without restrictions. The second method, however, requires user registration or installation of a special desktop app. Secure method was designed only for VIP users and later was reduced to simple registration or software installation. Download of both encrypted and not encrypted files can be performed without need of logging to the system.


## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See deployment for notes on how to deploy the project on a live system.

### Prerequisites


```
1.	NPM v6.12.0^ should be preinstalled
2.	Node v9.5.0^ should be preinstalled
3.	MySQL v5.5.53^ should be preinstalled
```

### Installing
Copy the file-exchanger folder on your computer by running
```
git clone https://github.com/Vladimir-125/file-exchanger
```

If node_modules folder does not exist in the project folder open cmd in current directory and run the following code: 
```
npm install
``` 
It will install all libraries specified in package.json file.

- Start MySQL server
- Create a MySQL database with provided MySQL code
- Modify file connectdb.js and enter there your database host name (usually localhost), user name, password, and database name where you have created tables from the MySQL code.
- Create new or use existing (not recommended) Gmail account.
- Go to security settings and allow less secure app access.
- Modify transporter.js file and enter there your Gmail email and your password.
- For the best practice I am storing password in environment variable by typing in cmd: set PASSWD=you_password and set EMAIL=you_email
- Run 
```
node server.js
``` 
command in cmd to start server.

The server usually starts on the port number 3000
If no other settings were changed, the webpage is accessible on 
```
http://localhost:3000. 
```

Check out [Demo](https://smf2.vladimir-125.repl.co "Open demo in new tab")