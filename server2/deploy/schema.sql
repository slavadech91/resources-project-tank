-- Base tables shared by authentication and the garage. Apply to an empty MariaDB database.
CREATE TABLE IF NOT EXISTS Users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(20) NOT NULL UNIQUE,
  password BINARY(60) NOT NULL,
  email VARCHAR(60),
  reg_date DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS UserProperties (
  id INT UNSIGNED PRIMARY KEY,
  crystals INT,
  score INT,
  last_visit DATETIME,
  next_crystal_reward DATETIME,
  user_roles JSON
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS UserItems (
  user_id INT UNSIGNED NOT NULL,
  item_id INT UNSIGNED NOT NULL,
  upgrading_property_id TINYINT UNSIGNED,
  upgrade_done_time DATETIME DEFAULT NULL,
  property_levels_id BIGINT UNSIGNED,
  count INT,
  temporary_item_expiration DATETIME DEFAULT NULL,
  PRIMARY KEY (user_id, item_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS PropertyLevels (
  id BIGINT UNSIGNED NOT NULL,
  property_id TINYINT NOT NULL,
  property_level SMALLINT NOT NULL,
  PRIMARY KEY (id, property_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS MountedItems (
  user_id INT UNSIGNED PRIMARY KEY,
  weapon_slot INT UNSIGNED,
  armor_slot INT UNSIGNED,
  color_slot INT UNSIGNED
) ENGINE=InnoDB;
