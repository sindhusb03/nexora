variable "i_understand_this_creates_resources" {
  type        = bool
  default     = false
  description = "Must be true before any resource can be created. Leave false. This stack has not been applied."
}

variable "name" {
  type    = string
  default = "nexora"
}

variable "api_image" {
  type        = string
  default     = "public.ecr.aws/docker/library/busybox:1.36"
  description = "Placeholder. Replace with a private ECR image before any real run. Do not apply from this repo."
}

variable "web_image" {
  type    = string
  default = "public.ecr.aws/docker/library/busybox:1.36"
}

variable "web_hostname" {
  type    = string
  default = "app.example.com"
}

variable "api_hostname" {
  type    = string
  default = "api.example.com"
}

variable "web_origin" {
  type    = string
  default = "https://app.example.com"
}
