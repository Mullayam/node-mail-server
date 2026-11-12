#!/bin/bash
# Interactive setup: writes server/.env and generates DNS records.
node "$(dirname "$0")/setup.js"
