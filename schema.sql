-- Schema for Send me file
CREATE TABLE IF NOT EXISTS files (
  file_id       INT          NOT NULL PRIMARY KEY,
  creation_date DATETIME     NOT NULL,
  password_hash VARCHAR(255) NOT NULL DEFAULT ''
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  salt          VARCHAR(64)  NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS not_confirmed (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  salt          VARCHAR(64)  NOT NULL DEFAULT '',
  password_hash VARCHAR(255) NOT NULL,
  confirm_url   VARCHAR(128) NOT NULL UNIQUE
) DEFAULT CHARSET = utf8mb4;
