-- lower() depends on the database locale, so this rule could wrongly reject
-- valid names on a database with a different locale. Case-insensitive
-- uniqueness is kept by the unique index on ("userId", "normalizedName"),
-- with normalizedName always computed by the application.
ALTER TABLE "categories" DROP CONSTRAINT "categories_normalizedName_check";
