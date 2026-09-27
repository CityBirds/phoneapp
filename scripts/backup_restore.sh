#!/usr/bin/env bash
set -e

ACTION=$1
DATA_DIR="./data"
BACKUP_DIR="./backups"

mkdir -p "$BACKUP_DIR"

if [ "$ACTION" = "backup" ]; then
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  BACKUP_PATH="$BACKUP_DIR/backup_$TIMESTAMP.tar.gz"
  tar -czf "$BACKUP_PATH" -C "$DATA_DIR" .
  echo "Backup created successfully: $BACKUP_PATH"
elif [ "$ACTION" = "restore" ]; then
  LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | head -n 1)
  if [ -z "$LATEST_BACKUP" ]; then
    echo "No backup file found in $BACKUP_DIR"
    exit 1
  fi
  mkdir -p "$DATA_DIR"
  tar -xzf "$LATEST_BACKUP" -C "$DATA_DIR"
  echo "Restored from latest backup: $LATEST_BACKUP"
else
  echo "Usage: $0 {backup|restore}"
  exit 1
fi
