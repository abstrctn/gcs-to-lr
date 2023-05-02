deploy:
	gcloud beta functions deploy gcs-to-lr \
		--region us-east4 \
		--runtime nodejs18 \
		--source . \
		--entry-point index \
		--trigger-bucket abstrctn-ftp \
		--timeout 120s \
		--memory 512Mi \
		--max-instances 5 \
		--set-secrets "ADOBE_ACCESS_TOKEN=ADOBE_ACCESS_TOKEN:latest" \
		--set-secrets "ADOBE_API_KEY=ADOBE_API_KEY:latest" \
		--set-secrets "ADOBE_CLIENT_ID=ADOBE_CLIENT_ID:latest" \
		--set-secrets "ADOBE_CLIENT_SECRET=ADOBE_CLIENT_SECRET:latest" \
		--set-secrets "ADOBE_CATALOG_ID=ADOBE_CATALOG_ID:latest" \
		--set-secrets "ADOBE_ACCOUNT_ID=ADOBE_ACCOUNT_ID:latest"
