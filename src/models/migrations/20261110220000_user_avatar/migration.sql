-- Profile pictures: object key in R2 (null = show initials).
ALTER TABLE "users" ADD COLUMN "avatar_key" VARCHAR(512);
