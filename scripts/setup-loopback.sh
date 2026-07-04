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
  # Use a host (/32) netmask, not the implicit class-A /8. Without an explicit netmask,
  # macOS gives each 127.0.0.x alias a 255.0.0.0 mask, so every alias claims to own the
  # entire 127.0.0.0/8 network. With a large COUNT that means dozens/hundreds of interface
  # addresses all asserting the same subnet, which drives mDNSResponder's address-conflict
  # defense (PacketRRConflict) into an O(n^2) storm — pinning a CPU core and flooding
  # 5353 with loopback announcements. A /32 host route removes the subnet overlap: each
  # alias is an isolated host, so there is no conflict cascade even at the full 254-address
  # pool. (Measured: 254 aliases /8 => ~65% CPU; 254 aliases /32 => ~0% CPU.)
  #
  # Remove any pre-existing alias first so re-running this converts a machine previously
  # configured with the old /8 aliases; ifconfig alias on an existing address does not
  # reliably reset its netmask. The `-alias` is a harmless no-op if the address is absent.
  sudo ifconfig lo0 -alias 127.0.0.$i 2>/dev/null
  sudo ifconfig lo0 alias 127.0.0.$i netmask 255.255.255.255 up
done

echo "✓ Configured $COUNT loopback addresses (127.0.0.$START-127.0.0.$END)"