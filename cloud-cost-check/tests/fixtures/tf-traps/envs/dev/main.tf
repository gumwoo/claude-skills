module "vpc" {
  source             = "terraform-aws-modules/vpc/aws"
  version            = "5.8.1"
  enable_nat_gateway = true
  single_nat_gateway = false
  azs                = ["ap-northeast-2a", "ap-northeast-2c"]
}

resource "aws_db_instance" "main" {
  instance_class    = "db.t3.medium"
  engine            = "postgres"
  allocated_storage = 50
  multi_az          = true
}

resource "aws_nat_gateway" "this" {
  count     = 2
  subnet_id = "subnet-${count.index}"
}

resource "aws_eks_node_group" "workers" {
  cluster_name   = "dev"
  instance_types = ["t2.large"]
  scaling_config {
    min_size     = 2
    max_size     = 2
    desired_size = 2
  }
}
