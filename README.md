# file-exchanger
	
	“Send me file” aims to provide another better and more comfortable way for sending and receiving files between various devises. This platform provides both web and desktop application so that clients would be able to send and receive any files only with the access to the Internet. Users can send files from any device to any other device if they have access to the Internet and a browser. For the convenience of desktop users, I have developed desktop version of “Send me file”. There is two ways of sending a file. 

	First, allows you to quickly send any file to the server which stores it some specific amount of time (1 hour). The server then provides key (4 digits. Can be increased to any other length later when the number of users reaches a point when generating a new key will take long time) to be used to download the file. It also provides QR code that can be used to download file. QR code has a direct link to download the file.

	Second, is secure method. It allows users to send files adding a password to them. The files are sent to the server on a secure https channel and stored in encrypted state on the server. The password used for encrypting the file deleted form the server immediately after encryption. The users are prompted to enter the proper password as well as the key of the file in order to download the file. The system is able to check if user enters the right password. When users follow the link encrypted in QR code, they still prompted to enter the password in case the file was encrypted. 

	First simple method does not need any registration process, and anyone can send and receive files without restrictions. The second method, however, requires user registration or installation of a special desktop app. Secure method was designed only for VIP users and later was reduced to simple registration or software installation. Download of both encrypted and not encrypted files can be performed without need of logging to the system.



	Manual to run the code

1.	Copy the file-exchanger folder on your computer
2.	If node_modules folder does not exist in the project folder open cmd in current directory and run the following code: npm install 
It will install all libraries specified in package.json file.
3.	Start MySQL server
4.	Create a MySQL database with provided MySQL code
5.	Modify file connectdb.js and enter there your database host name (usually localhost), user name, password, and database name where you have created tables from the MySQL code.
6.	Create new or use existing (not recommended) Gmail account.
7.	Go to security settings and allow less secure app access.
8.	Modify transporter.js file and enter there your Gmail email and your password.
9.	For the best practice I am storing password in environment variable by typing in cmd: set PASSWD=you_password and set EMAIL=you_email
10.	Run node server.js command in cmd to start server.
11.	The server usually starts on the port number 3000
12.	If no other settings were changed, the webpage is accessible on http://localhost:3000. 
