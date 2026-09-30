# Hosting

Config and templates only. Nothing in this repository has been deployed, and no cloud resources have been created. Do not run `terraform apply` or point `docker compose` at a cloud account.

The local stack is `docker-compose.yml`: web, API, Postgres 17 with pgvector, and MinIO. `CREATE EXTENSION vector` lives in `deploy/postgres/20-pgvector.sql` for that image only. Shared migrations do not create the extension, because CI Postgres and PGlite do not ship it.

## AWS region

Primary region is **ap-south-1 (Mumbai)**. Templates are in `infra/aws/ap-south-1/`. Apply is guarded by `i_understand_this_creates_resources`, which defaults to false.

### ECS Fargate, not App Runner

|           | App Runner                                                                                | ECS Fargate (chosen)                                                                   |
| --------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Fit       | One container, managed HTTPS, little network control                                      | Private tasks, RDS in private subnets, a migration task, separate web and API services |
| Data path | Simpler, and the database is often reachable from the service network with less isolation | Tasks stay in private subnets. The load balancer is the only public ingress            |
| Cost      | Lower at idle for a single service                                                        | Higher (NAT or VPC endpoints, load balancer)                                           |

Fargate is the choice because the API must reach RDS and object storage without a public database, and migrations must run as the schema owner in a separate task. App Runner remains a possible later host for the web container alone.

The template includes a VPC with public and private subnets, an RDS Postgres instance with pgvector available, 7-day backups (PITR while retention is at least one day), an S3 bucket with SSE-KMS and public access blocked, Secrets Manager entries for the database URL and `AUTH_SECRET`, and Fargate services for the API and web app. Images are references only. The template does not build or push them.

## Data residency

India's Digital Personal Data Protection Act, 2023 applies to personal data processed in India and to processing outside India when it is in connection with offering goods or services in India. Nexora is the data fiduciary for account and customer content it stores. Obligations include a lawful purpose, notice, security safeguards, and breach notice to the Data Protection Board and affected data principals. The government may restrict transfers to notified countries (section 16). Until a restriction is notified, a transfer still has to meet the Act. A significant-data-fiduciary designation would add a data-protection officer, an independent audit, and a data-protection impact assessment. Do not assume that designation; design as if it can be applied later.

Primary storage for this stack is ap-south-1: RDS, S3, Secrets Manager, and logs. Do not add a cross-region replica, a multi-region bucket, or an offshore backup vault in the current template.

Customers in the US, UK, EU, Singapore, UAE, Japan, and Australia bring their own rules (state privacy laws, UK GDPR, GDPR, PDPA, PDPL, APPI, and the Australian Privacy Act). Cross-border processing needs a recorded purpose, a transfer mechanism the customer's regime accepts, and no silent copy of tenant data outside the home region. `NEXORA_REGION` already pins a session to one region. A tenant's home region is the region on the tenant row.

A later multi-region layout is separate stacks per home region, one database per region, tenant placement chosen at provision time, and no shared ledger. This outline is not built.
