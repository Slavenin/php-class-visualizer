#!/bin/bash
# entrypoint.sh

set -e

# Configure PHP
echo "memory_limit = ${PHP_MEMORY_LIMIT:-512M}" > /usr/local/etc/php/conf.d/custom.ini
echo "max_execution_time = ${PHP_MAX_EXECUTION_TIME:-300}" >> /usr/local/etc/php/conf.d/custom.ini
echo "error_reporting = E_ALL" >> /usr/local/etc/php/conf.d/custom.ini
echo "display_errors = On" >> /usr/local/etc/php/conf.d/custom.ini

echo "========================================="
echo "PHP Dependency Parser Container"
echo "========================================="
echo "Input directory: /app/input"
echo "Output directory: /app/output"
echo "PHP Memory Limit: ${PHP_MEMORY_LIMIT:-512M}"
echo "Max Execution Time: ${PHP_MAX_EXECUTION_TIME:-300}s"
echo "========================================="

# Check if input directory has files
if [ ! "$(ls -A /app/input 2>/dev/null)" ]; then
    echo ""
    echo "WARNING: Input directory is empty!"
    echo "Please mount your PHP project to /app/input"
    echo "Example: docker run -v /path/to/project:/app/input ..."
    echo ""
fi

# Execute command
if [ $# -gt 0 ]; then
    exec "$@"
else
    # Default command
    exec php /app/php_dependency_parser.php \
        -d /app/input \
        -o /app/output/dependencies \
        --exclude "*tests*" \
        --format json 
fi