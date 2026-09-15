L2/L3 parity contract. Each JSON is one accept/reject case for a lock artifact or lock file.

- `entry`: lock artifact or whole lock
- `bytesHex`: optional raw file bytes the verifier hashes
- `expected.accept`: true if the verifier must accept
- `expected.reasonCode`: ERROR_CODES value when rejected
