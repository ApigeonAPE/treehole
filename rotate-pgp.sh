#!/bin/bash
# PGP key rotation script
# Requires: apt install -y gnupg
# Usage: ./rotate-pgp.sh
# cron: 0 3 1 * * cd /opt/treehole && bash rotate-pgp.sh >> /var/log/pgp-rotate.log 2>&1

set -e

PGP_DIR="/opt/treehole/haraka/pgp"
BACKUP_DIR="$PGP_DIR/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
KEY_NAME="Treehole Mail Gateway"
KEY_EMAIL="noreply@mail.treehole.example"

echo "=== $(date) PGP key rotation ==="

# check dependencies
if ! command -v gpg &>/dev/null; then
    echo "Please install gnupg first: apt install -y gnupg"
    exit 1
fi

# back up old keys
mkdir -p "$BACKUP_DIR"
if [ -f "$PGP_DIR/private.asc" ]; then
    cp "$PGP_DIR/private.asc" "$BACKUP_DIR/private-${TIMESTAMP}.asc"
    cp "$PGP_DIR/public.asc"  "$BACKUP_DIR/public-${TIMESTAMP}.asc"
    echo "Old keys backed up to $BACKUP_DIR"
fi

# generate a new key
echo "Generating RSA 3072 key..."
gpg --batch --passphrase '' --quick-generate-key \
    "$KEY_NAME <$KEY_EMAIL>" \
    rsa3072 default 1y 2>&1

# read the fingerprint
FINGERPRINT=$(gpg --list-keys --with-colons "$KEY_EMAIL" 2>/dev/null | grep '^fpr:' | tail -1 | cut -d: -f10)

if [ -z "$FINGERPRINT" ]; then
    echo "ERROR: could not read the fingerprint"
    exit 1
fi

echo "New key fingerprint: $FINGERPRINT"

# export
gpg --armor --export "$FINGERPRINT" > "$PGP_DIR/public.asc"
gpg --armor --export-secret-keys "$FINGERPRINT" > "$PGP_DIR/private.asc"

chmod 600 "$PGP_DIR/private.asc"
chmod 644 "$PGP_DIR/public.asc"

# remove the key from the local keyring (already exported to files)
gpg --batch --yes --delete-secret-keys "$FINGERPRINT" 2>/dev/null
gpg --batch --yes --delete-keys "$FINGERPRINT" 2>/dev/null

# prune old backups (keep the last 5)
ls -1t "$BACKUP_DIR"/private-*.asc 2>/dev/null | tail -n +6 | xargs -r rm
ls -1t "$BACKUP_DIR"/public-*.asc  2>/dev/null | tail -n +6 | xargs -r rm

# restart Haraka
cd /opt/treehole
docker compose restart haraka

echo "Key rotation complete"
