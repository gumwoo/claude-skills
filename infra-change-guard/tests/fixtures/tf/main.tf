# 정적 점검 시험용 코드. 실제로 적용하지 않는다.

resource "aws_db_instance" "unprotected" {
  identifier          = "app"
  engine              = "postgres"
  skip_final_snapshot = true
  # deletion_protection = true   (주석 안의 값은 무시되어야 한다)
}

resource "aws_db_instance" "protected" {
  identifier              = "billing"
  engine                  = "postgres"
  deletion_protection     = true
  backup_retention_period = 7
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "assets" {
  bucket        = "assets-{brace-in-string}"
  force_destroy = true
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs"
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_dynamodb_table" "sessions" {
  name     = "sessions"
  hash_key = "id"
  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_rds_cluster" "from_var" {
  cluster_identifier  = "analytics"
  deletion_protection = var.deletion_protection
}

resource "aws_kms_key" "data" {
  deletion_window_in_days = 7
}

resource "aws_iam_role" "app" {
  name = "app"
}
