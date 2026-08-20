# Security Policy

## Supported versions

Security fixes are provided for the latest published release and the current `main` branch.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, exposed credentials, or private user data. Use GitHub's private vulnerability reporting for this repository when available, or contact `guzilab@163.com` with a minimal reproduction that does not include real API keys, documents, or user data.

API keys configured in Guzi Scholar are stored on the local device and are sent only to the AI service selected by the user. Remote AI endpoints must use HTTPS; plain HTTP is accepted only for loopback development services.

Never commit `data/`, `developer.tokens.json`, `.env` files, private keys, credentials, or production deployment configuration. Pull requests and pushes are scanned for common secret formats in CI.
