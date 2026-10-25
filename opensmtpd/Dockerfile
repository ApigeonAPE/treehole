FROM alpine:3.20

# Install OpenSMTPD
RUN apk add --no-cache opensmtpd

# Create required directories with correct permissions
# OpenSMTPD runs as root, spool must be owned by root:root with mode 711
RUN mkdir -p /var/spool/smtpd /etc/mail/dkim && \
    chown root:root /var/spool/smtpd && \
    chmod 711 /var/spool/smtpd

# Copy config
COPY smtpd.conf /etc/smtpd/smtpd.conf

# Expose port 10025 (internal; Haraka and the web server connect here to send)
EXPOSE 10025

# Run OpenSMTPD in foreground, verbose for logging
CMD ["smtpd", "-d", "-v"]
