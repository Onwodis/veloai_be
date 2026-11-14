-- Gender and date of birth, asked at sign-up (nullable for accounts created before).
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

ALTER TABLE "users"
  ADD COLUMN "gender" "Gender",
  ADD COLUMN "date_of_birth" DATE;
