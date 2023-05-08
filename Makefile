deploy:
	gcloud beta functions deploy gcs-to-lr \
		--region us-east4 \
		--runtime nodejs18 \
		--source . \
		--entry-point index \
		--trigger-bucket abstrctn-ftp \
		--timeout 120s \
		--memory 256Mi \
		--max-instances 5 \
		--set-env-vars "ADOBE_CLIENT_ID=441b4e2d38004854b98662f66a06d897" \
		--set-env-vars "ADOBE_CATALOG_ID=d55f645a02a8422dbcf188ba1ea5ad7b" \
		--set-env-vars "ADOBE_ACCOUNT_ID=570b682eb454cd23cfa5b691733f0d12"

deploystatus:
	gcloud beta functions deploy gcs-to-lr-status-data \
		--gen2 \
		--allow-unauthenticated \
		--region us-east4 \
		--runtime nodejs18 \
		--source . \
		--entry-point statusData \
		--trigger-http

	gcloud beta functions deploy gcs-to-lr-status \
		--gen2 \
		--allow-unauthenticated \
		--region us-east4 \
		--runtime nodejs18 \
		--source . \
		--entry-point status \
		--trigger-http
