# Makefile

.PHONY: help build run parse visualize clean logs

help: ## Показать справку
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

build: ## Собрать Docker образы
	docker-compose build

run: ## Запустить все сервисы
	docker-compose up -d

parse: ## Запустить только парсер
	docker-compose run --rm parser

parse-interactive: ## Запустить парсер в интерактивном режиме
	docker-compose --profile interactive run --rm parser-interactive bash

visualize: ## Открыть веб-визуализатор
	@echo "Opening http://localhost:8080?data=/data/dependencies.json"
	@xdg-open http://localhost:8080?data=/data/dependencies.json 2>/dev/null || open http://localhost:8080?data=/data/dependencies.json 2>/dev/null || echo "Please open http://localhost:8080?data=/data/dependencies.json in your browser"

gephi: ## Запустить Gephi
	docker-compose --profile gephi up -d gephi

logs: ## Показать логи
	docker-compose logs -f

stop: ## Остановить все сервисы
	docker-compose down

clean: ## Очистить все
	docker-compose down -v
	rm -rf output/*

shell: ## Подключиться к контейнеру парсера
	docker-compose exec parser bash

test: ## Тестовый запуск на примере
	mkdir -p test_project
	echo "<?php namespace App\Controller; use App\Entity\User; class UserController { public function index(User \$user) {} }" > test_project/TestController.php
	docker-compose run --rm -v $(PWD)/test_project:/app/input parser
	cat output/dependencies.json | python -m json.tool
