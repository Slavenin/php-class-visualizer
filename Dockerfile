# Dockerfile
FROM php:8.5-cli

# Install dependencies
RUN apt-get update && apt-get install -y \
    git \
    unzip \
    libzip-dev \
    && docker-php-ext-install zip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy scripts
COPY php_dependency_parser.php /app/
COPY entrypoint.sh /app/

# Make entrypoint executable
RUN chmod +x /app/entrypoint.sh

# Create directories
RUN mkdir -p /app/input /app/output && \
    chmod 777 /app/output

# Set entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]

# Default command
CMD ["php", "/app/php_dependency_parser.php", "-d", "/app/input", "-o", "/app/output/dependencies", "--format", "json"]