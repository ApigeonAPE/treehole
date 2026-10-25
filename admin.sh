#!/bin/bash
# Admin CLI - run from the project root
# ./admin.sh --whois luw4
# ./admin.sh --hide '#a31u02'
# ./admin.sh --ban <UID> 30
# ./admin.sh --unban <UID>
# ./admin.sh --history <UID>

docker exec treehole-web node src/admin.js "$@"
