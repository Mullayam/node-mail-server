#!/bin/bash

# Ensure Node.js is installed
if ! command -v node &> /dev/null
then
    echo "Node.js is not installed. Please install it and try again."
    exit 1
fi

# Prompt the user for a domain name
read -p "Enter the domain name: " DOMAIN_NAME

# Ensure a domain name is provided
if [ -z "$DOMAIN_NAME" ]; then
    echo "No domain name provided. Exiting..."
    exit 1
fi

# Export the domain name as an environment variable
export DOMAIN_NAME

# Execute the TypeScript file using ts-node if available, otherwise compile & run
if command -v ts-node &> /dev/null; then
    ts-node ./src/start.ts
else
    echo "ts-node is not installed. Attempting to compile and run with Node.js..."
    npx tsc && node ./build/start.js
fi
