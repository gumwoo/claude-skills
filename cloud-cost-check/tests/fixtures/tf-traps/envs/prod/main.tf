# 운영 환경 { 주석 안의 중괄호는 무시돼야 한다
variable "db_multi_az" {
  type    = bool
  default = false
}

variable "app_count" {
  type = number
}

resource "aws_db_instance" "main" {
  identifier        = "app-prod"
  instance_class    = "db.m4.large"
  engine            = "postgres"
  allocated_storage = 200
  storage_type      = "gp2"
  multi_az          = var.db_multi_az
  tags = {
    Environment = "prod"
  }
}

resource "aws_nat_gateway" "this" {
  count         = 1
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = "subnet-123"
}

resource "aws_launch_template" "app" {
  name_prefix   = "app-"
  instance_type = "m5.large"
  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "{ not a block }" > /etc/motd
    if [ -f /x ]; then echo "}"; fi
  EOT
  )
}

resource "aws_autoscaling_group" "app" {
  min_size         = 4
  max_size         = 4
  desired_capacity = 4
  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }
}

resource "aws_instance" "batch" {
  count         = var.app_count
  instance_type = "c5.xlarge"
}

resource "aws_cloudwatch_log_group" "app" {
  name = "/app/prod" // retention 없음
}

/* 여러 줄 주석
resource "aws_nat_gateway" "commented_out" { }
*/
