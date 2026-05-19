# Makefile

.PHONY: help build run parse visualize clean logs

build: ## Собрать Docker образы
	docker-compose build

run: ## Запустить все сервисы
	docker-compose up -d web-visualizer

parse: ## Запустить только парсер
	docker-compose run --rm parser

parse-interactive: ## Запустить парсер в интерактивном режиме
	docker-compose --profile interactive run --rm parser-interactive bash

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
