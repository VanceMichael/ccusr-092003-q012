
.PHONY: migrate seed reset-seed test demo run
migrate:
	npm run migrate
seed:
	npm run seed
reset-seed:
	RESET=1 npm run seed
test:
	npm test
demo:
	npm run demo
run:
	npm start
