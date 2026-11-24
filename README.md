# file-exchanger
	
“Send me file” aims to provide another better and more comfortable way for sending and receiving files between various devises. This platform provides both web and desktop application so that clients would be able to send and receive any files only with the access to the Internet. Users can send files from any device to any other device if they have access to the Internet and a browser. For the convenience of desktop users, I have developed desktop version of “Send me file”. There is two ways of sending a file. 

First, allows you to quickly send any file to the server which stores it some specific amount of time (1 hour). The server then provides key (4 digits. Can be increased to any other length later when the number of users reaches a point when generating a new key will take long time) to be used to download the file. It also provides QR code that can be used to download file. QR code has a direct link to download the file.

Second, is secure method. It allows users to send files adding a password to them. The files are sent to the server on a secure https channel and stored in encrypted state on the server. The password used for encrypting the file deleted form the server immediately after encryption. The users are prompted to enter the proper password as well as the key of the file in order to download the file. The system is able to check if user enters the right password. When users follow the link encrypted in QR code, they still prompted to enter the password in case the file was encrypted. 

First simple method does not need any registration process, and anyone can send and receive files without restrictions. The second method, however, requires user registration or installation of a special desktop app. Secure method was designed only for VIP users and later was reduced to simple registration or software installation. Download of both encrypted and not encrypted files can be performed without need of logging to the system.

First simple method does not need any registration process, and anyone can send and receive files without restrictions. The second method, however, requires user registration or installation of a special desktop app. Secure method was designed only for VIP users and later was reduced to simple registration or software installation. Download of both encrypted and not encrypted files can be performed without need of logging to the system.


## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See deployment for notes on how to deploy the project on a live system.

### Prerequisites

- Node.js 18+ and npm
- MySQL 8 (or Docker to run it in a container)

### Installing

```
git clone https://github.com/Vladimir-125/file-exchanger
cd file-exchanger
npm install
cp .env.example .env   # then edit the values
```

Start MySQL and load the schema. With Docker:

```
docker run -d --name file-exchanger-mysql -p 127.0.0.1:3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=fileexchanger \
  -e MYSQL_USER=fileexchanger -e MYSQL_PASSWORD=change-me \
  -v "$PWD/schema.sql:/docker-entrypoint-initdb.d/schema.sql:ro" mysql:8.0
```

Or against an existing server: `mysql -u <user> -p <database> < schema.sql`.

For signup confirmation emails, set `EMAIL` and `PASSWD` in `.env` to a Gmail
address and an [app password](https://myaccount.google.com/apppasswords).

Run the server:

```
npm start
```

The app listens on `PORT` from `.env` (default 3000): http://localhost:3000

Check out [Demo](http://13.125.60.5/ "Open demo in new tab")
