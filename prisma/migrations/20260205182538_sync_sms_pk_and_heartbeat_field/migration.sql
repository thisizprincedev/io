/*
  Warnings:

  - The primary key for the `sms_messages` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "heartbeat" JSONB;

-- AlterTable
ALTER TABLE "sms_messages" DROP CONSTRAINT "sms_messages_pkey",
ADD CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("device_id", "local_sms_id");
