# Separate rules avoid a cycle between the load balancer, task, and database groups.

resource "aws_security_group_rule" "alb_to_api" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  from_port                = 8787
  to_port                  = 8787
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.tasks.id
}

resource "aws_security_group_rule" "alb_to_web" {
  type                     = "egress"
  security_group_id        = aws_security_group.alb.id
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.tasks.id
}

resource "aws_security_group_rule" "tasks_to_db" {
  type                     = "egress"
  security_group_id        = aws_security_group.tasks.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.db.id
}

resource "aws_lb" "main" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 8787
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path = "/readyz"
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path = "/"
  }
}

resource "aws_acm_certificate" "main" {
  domain_name               = var.web_hostname
  subject_alternative_names = [var.api_hostname]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [var.api_hostname]
    }
  }
}
