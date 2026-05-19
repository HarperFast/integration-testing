#!/bin/bash

# Prompt for password upfront
sudo -v

# The pool starts at 127.0.0.2 by default (127.0.0.1 is left for other services on localhost).
# Override via the HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START environment variable.
START=${HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START:-2}

# Validate START is a number between 1 and 255
if ! [[ "$START" =~ ^[0-9]+$ ]]; then
  echo "Error: HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START must be a number (got: $START)"
  exit 1
fi

if [ "$START" -lt 1 ] || [ "$START" -gt 255 ]; then
  echo "Error: HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START must be between 1 and 255 (got: $START)"
  exit 1
fi

# Use environment variable or default to 32
COUNT=${HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT:-32}
MAX=$((256 - START))

# Validate COUNT is a number between 1 and MAX
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "Error: HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT must be a number (got: $COUNT)"
  exit 1
fi

if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt "$MAX" ]; then
  echo "Error: HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT must be between 1 and $MAX (got: $COUNT)"
  exit 1
fi

END=$((START + COUNT - 1))
for i in $(seq $START $END); do
  sudo ifconfig lo0 alias 127.0.0.$i up
done

echo "✓ Configured $COUNT loopback addresses (127.0.0.$START-127.0.0.$END)"