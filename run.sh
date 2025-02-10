#!/bin/bash
#!/bin/bash

validate_env() {
    local missing_vars=()
    
    # List of required environment variables
    local required_vars=("MAIL_HOST" "MAIL_SERVER_IP" )

    for var in "${required_vars[@]}"; do
        if [[ -z "${!var}" ]]; then
            missing_vars+=("$var")
        fi
    done

    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        echo "Error: The following environment variables are missing or empty:"
        for var in "${missing_vars[@]}"; do
            echo "  - $var"
        done
        exit 1
    fi

    # Validate MAIL_SERVER_IP (Must be a valid IPv4 address)
    if ! [[ "$MAIL_SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        echo "Error: MAIL_SERVER_IP is not a valid IPv4 address."
        exit 1
    fi

    

    echo "All environment variables are valid."
}

# Run validation
validate_env

# Ensure Node.js is installed
if ! command -v node &> /dev/null
then
    echo "Node.js is not installed. Please install it and try again."
    exit 1
fi

# Execute the TypeScript file using ts-node if available, otherwise compile & run
if command -v ts-node &> /dev/null; then
    ts-node ./src/start.ts
else
    echo "ts-node is not installed. Attempting to compile and run with Node.js..."
    npx tsc && node ./dist/start.js
fi
