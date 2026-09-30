# ap-south-1 template

Not applied. No VPC, RDS, S3, secret, or ECS resource has been created.

`i_understand_this_creates_resources` defaults to false, so `terraform plan` and `terraform apply` fail the `apply_guard` precondition. Leave it false.

Trade-off and residency: `docs/hosting.md`. ECS Fargate is the chosen compute. App Runner is documented there and not templated.
